require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    ChannelType,
    REST,
    Routes,
    PermissionFlagsBits
} = require("discord.js");

const axios = require("axios");

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

const { handleCleanupValidators, handleCleanupConfirmation } = require("./roles/validators-cleanup");

const {
    handleCleanupDelegators,
    handleCleanupDelegatorConfirmation
} = require("./roles/delegators-cleanup");

const setupAutoModIntegration = require("./utils/automodIntegration");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TEAM_ROLE_ID = process.env.TEAM_ROLE_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration
    ]
});

client.once("ready", async () => {
    console.log(`🤖 Bot is running as ${client.user.tag}`);

    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

    // Register slash commands
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
            name: "cleanup-inactive-validators",
            description: "Remove validator role from inactive bakers",
            default_member_permissions: PermissionFlagsBits.Administrator.toString()
        },
        {
            name: "cleanup-inactive-delegators",
            description: "Remove delegator role from inactive users",
            default_member_permissions: PermissionFlagsBits.Administrator.toString()
        }
    ];

    try {
        const data = await rest.put(
            Routes.applicationGuildCommands(client.user.id, DISCORD_GUILD_ID),
            { body: commands }
        );
        console.log(`✅ Successfully registered ${data.length} slash commands:`);
        data.forEach(cmd => console.log(`- /${cmd.name}`));
    } catch (err) {
        console.error("❌ Failed to register slash commands:", err);
    }
});

// !setup command restricted to TEAM_ROLE_ID
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

// Handle all interactions
client.on("interactionCreate", async (interaction) => {
    if (interaction.isStringSelectMenu() && interaction.customId === "role_verification_menu") {
        const discordId = interaction.user.id;
        const state = Math.random().toString(36).substring(2, 18);

        switch (interaction.values[0]) {
            case "verify_dev":
                return handleDevVerification(interaction, discordId, state, client);
            case "verify_validator":
                return handleValidatorVerification(interaction, discordId, client);
            case "verify_delegator":
                return handleDelegatorVerification(interaction, discordId, client);
        }
    }

    if (interaction.isChatInputCommand()) {
        console.log(`Received command: /${interaction.commandName}`);

        switch (interaction.commandName) {
            case "start-again-validator":
                return restartValidatorFlow(interaction, client);
            case "start-again-delegator":
                return restartDelegatorFlow(interaction, client);
            case "cleanup-inactive-validators":
                return handleCleanupValidators(interaction);
            case "cleanup-inactive-delegators":
                return handleCleanupDelegators(interaction);
        }
    }

    if (interaction.isButton()) {
        // Handle validator cleanup confirmation buttons
        if (interaction.customId.startsWith('confirm_validator') || interaction.customId.startsWith('cancel_validator')) {
            return handleCleanupConfirmation(interaction);
        }

        // Handle delegator cleanup confirmation buttons
        if (interaction.customId.startsWith('confirm_delegator') || interaction.customId.startsWith('cancel_delegator')) {
            return handleCleanupDelegatorConfirmation(interaction);
        }
    }
});

// Thread message handlers
listenForValidatorMessages(client);
listenForDelegatorMessages(client);

// AutoMod setup
setupAutoModIntegration(client);

// Start bot
client.login(DISCORD_BOT_TOKEN);