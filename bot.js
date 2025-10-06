/**
 * Entry point for the Discord bot.
 * Responsibilities:
 * - Creates a Discord.js Client with required intents (guilds, messages, moderation, members, content).
 * - Registers guild slash commands:
 *   /start-again-validator, /start-again-delegator, /receive-notifications (with on/off choice), /reconcile_roles (mods only).
 * - Handles `!setup` to post a role verification select menu and routes selections to:
 *   - Developer verification (GitHub-based),
 *   - Validator verification (on-chain transaction),
 *   - Delegator verification (on-chain transaction).
 * - Wires verification flows (start/restart) and message listeners for validator/delegator flows.
 * - Integrates AutoMod, per-user notification preferences, and alerts (injects the Discord client).
 * - Connects to a Concordium node via gRPC (tx logger), pings it, and starts a listener.
 * - Handles member leave events to perform cleanup logic.
 * - Logs bot in using DISCORD_BOT_TOKEN.
 */
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  REST,
  Routes,
  MessageFlags,
} = require("discord.js");

const handleDevVerification = require("./roles/devVerification");
const {
  handleValidatorVerification,
  listenForValidatorMessages,
  restartValidatorFlow
} = require("./roles/validatorVerification");
const {
  handleDelegatorVerification,
  listenForDelegatorMessages,
  restartDelegatorFlow
} = require("./roles/delegatorVerification");

const setupAutoModIntegration = require("./utils/automodIntegration");
const { handleMemberLeave } = require("./modules/member-leave-handler");
const { setAlertsClient } = require("./modules/alerts");
const { handleReceiveNotifications } = require("./modules/notificationPrefs");
const { runBackfillFromCsv, runPostImportEnrichment } = require("./scripts/backfill");
const { reconcileRoles } = require("./modules/roleReconciler");

let _txloggerMod = null;

async function _getTxLogger() {
  if (_txloggerMod) return _txloggerMod;
  const m = await import("./modules/txloggerListener.js");
  _txloggerMod = m?.default || m;
  return _txloggerMod;
}
async function pingTxLogger() {
  const m = await _getTxLogger();
  return m.pingTxLogger();
}
function startTxLoggerListener() {
  _getTxLogger()
    .then((m) => m.startTxLoggerListener())
    .catch((e) => {
      console.warn("⚠️ Could not start gRPC listener:", e?.message || e);
    });
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TEAM_ROLE_ID = process.env.TEAM_ROLE_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers
  ]
});

function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function sendModLog(content) {
  if (!MOD_LOGS_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(MOD_LOGS_CHANNEL_ID).catch(() => null);
    if (ch?.isTextBased?.()) {
      await ch.send(content);
    } else {
      console.warn("⚠️ [modlog] MOD_LOGS_CHANNEL_ID is not a text channel or cannot be fetched");
    }
  } catch (e) {
    console.warn("⚠️ [modlog] Failed to send:", e?.message || e);
  }
}

function hasRoleByEnvOrName(member, roleIdEnv, nameRegex) {
  if (!member) return false;
  if (roleIdEnv && member.roles.cache.has(roleIdEnv)) return true;
  if (nameRegex) {
    return member.roles.cache.some(r => nameRegex.test(r.name || ""));
  }
  return false;
}

client.once("clientReady", async () => {
  console.log(`🤖 Bot is running as ${client.user.tag}`);

  setAlertsClient(client);

  const csvPath     = process.env.IMPORT_VERIFICATIONS_CSV;
  const runOnEmpty  = toBool(process.env.IMPORT_RUN_ON_EMPTY);
  const doEnrich    = toBool(process.env.IMPORT_POST_ENRICH);
  const debugBackfill = toBool(process.env.BACKFILL_DEBUG);

  if (csvPath) {
    try {
      await runBackfillFromCsv({ csvPath, runOnEmpty, debug: debugBackfill });
    } catch (_) {}
  }

  if (doEnrich) {
    try {
      await runPostImportEnrichment({ debug: debugBackfill });
    } catch (_) {}
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  const commands = [
    {
      name: "start-again-validator",
      description: "Restart your validator verification"
    },
    {
      name: "start-again-delegator",
      description: "Restart your delegator verification"
    },
    {
      name: "receive-notifications",
      description: "Turn personal notifications on or off",
      options: [
        {
          type: 3,
          name: "state",
          description: "Enable or disable personal notifications",
          required: true,
          choices: [
            { name: "on",  value: "on"  },
            { name: "off", value: "off" }
          ]
        }
      ]
    },
    {
      name: "reconcile_roles",
      description: "Fix Discord roles & DB after downtime (mods only)"
    }
  ];

  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log(`✅ Successfully registered ${data.length} slash commands:`);

    const registered = await rest.get(
      Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID)
    );
    for (const c of registered) console.log(`- /${c.name}`);
  } catch (err) {
    console.error("❌ Failed to register slash commands:", err);
  }

  try {
    await pingTxLogger();
    console.log("✅ Connected to Concordium node via gRPC");
  } catch (e) {
    console.warn("⚠️ Could not reach Concordium gRPC node:", e?.message || e);
  }

  startTxLoggerListener();
});

client.on("messageCreate", async (message) => {
  if (message.content === "!setup") {
    if (!message.member.roles.cache.has(TEAM_ROLE_ID)) {
      await message.reply("❌ You do not have permission to use this command.");
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("role_verification_menu")
      .setPlaceholder("Select a role to verify")
      .addOptions([
        {
          label: "Get developer role",
          description: "Verify your GitHub account",
          value: "verify_dev"
        },
        {
          label: "Get validator role",
          description: "Verify validator ownership via on-chain transaction",
          value: "verify_validator"
        },
        {
          label: "Get delegator role",
          description: "Verify delegation via on-chain transaction",
          value: "verify_delegator"
        }
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await message.channel.send({
      content: "🔽 Select the role you want to verify:",
      components: [row]
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "role_verification_menu"
  ) {
    const discordId = interaction.user.id;
    const member = interaction.guild
      ? await interaction.guild.members.fetch(discordId).catch(() => null)
      : null;

    const who = `<@${discordId}> (${interaction.user.tag})`;
    const where =
      interaction.channel && interaction.channel.id
        ? ` in <#${interaction.channel.id}>`
        : "";

    const DEV_ROLE_ID        = process.env.DEV_ROLE_ID;
    const VALIDATOR_ROLE_ID  = process.env.VALIDATOR_ROLE_ID;
    const DELEGATOR_ROLE_ID  = process.env.DELEGATOR_ROLE_ID;

    switch (interaction.values[0]) {
      case "verify_dev": {
        const already = hasRoleByEnvOrName(member, DEV_ROLE_ID, /developer/i);
        if (!already) {
          await sendModLog(`📝 Verification initiated: **Developer** by ${who}${where}`);
        }
        return handleDevVerification(interaction, discordId, client);
      }
      case "verify_validator": {
        const already = hasRoleByEnvOrName(member, VALIDATOR_ROLE_ID, /validator/i);
        if (!already) {
          await sendModLog(`📝 Verification initiated: **Validator** by ${who}${where}`);
        }
        return handleValidatorVerification(interaction, discordId, client);
      }
      case "verify_delegator": {
        const already = hasRoleByEnvOrName(member, DELEGATOR_ROLE_ID, /delegator/i);
        if (!already) {
          await sendModLog(`📝 Verification initiated: **Delegator** by ${who}${where}`);
        }
        return handleDelegatorVerification(interaction, discordId, client);
      }
    }
  }

  if (interaction.isChatInputCommand()) {
    console.log(`Received command: /${interaction.commandName}`);

    const who = `<@${interaction.user.id}> (${interaction.user.tag})`;
    const where =
      interaction.channel && interaction.channel.id
        ? ` in <#${interaction.channel.id}>`
        : "";

    switch (interaction.commandName) {
      case "start-again-validator":
        await sendModLog(`🔁 Restart requested: **Validator** by ${who}${where}`);
        return restartValidatorFlow(interaction, client);

      case "start-again-delegator":
        await sendModLog(`🔁 Restart requested: **Delegator** by ${who}${where}`);
        return restartDelegatorFlow(interaction, client);

      case "receive-notifications":
        return handleReceiveNotifications(interaction);

      case "reconcile_roles": {
        const member = interaction.guild
          ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
          : null;

        if (!member || !member.roles.cache.has(TEAM_ROLE_ID)) {
          return interaction.reply({
            content: "❌ You do not have permission to use this command.",
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.reply({
          content: "🔧 Reconciling roles & DB…",
          flags: MessageFlags.Ephemeral,
        });
        await sendModLog(`🧰 Reconcile requested by ${who}${where}`);

        try {
          await reconcileRoles(client, { deleteRows: true, debug: true });
          await interaction.editReply("✅ Reconcile finished.");
          await sendModLog(`✅ Reconcile finished (requested by ${who})`);
        } catch (e) {
          console.error("[reconcile] handler error:", e);
          try { await interaction.editReply(`❌ Reconcile failed: ${e?.message || e}`); } catch {}
          await sendModLog(`❌ Reconcile failed (requested by ${who}): ${e?.message || e}`);
        }
        return;
      }
    }
  }
});

client.on("guildMemberRemove", async (member) => {
  console.log(`👋 Member left: ${member.user.tag}`);
  await handleMemberLeave(member);
});

listenForValidatorMessages(client);
listenForDelegatorMessages(client);
setupAutoModIntegration(client);

client.login(DISCORD_BOT_TOKEN);