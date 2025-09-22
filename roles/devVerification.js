// roles/devVerification.js
/**
 * Handles **Developer** role verification via GitHub OAuth.
 * Responsibilities:
 * - Starts OAuth.
 * - Sends an ephemeral Discord message with requirements and a GitHub auth link.
 * - Callback validation:
 *   • GitHub account age ≥ 3 months,
 *   • ≥ 1 public repository,
 *   • ≥ 5 authored commits across repos,
 *   • Stars required Concordium repos,
 *   • Prevents reuse of the same GitHub profile (duplicate check).
 * - On success: assigns <@&DEV_ROLE_ID>, logs to moderators channel, and saves a row in Postgres (`verifications`).
 * - Exports: default handler, `processGithubCallback`, `saveDeveloperVerification`, `checkDuplicateGithubProfile`.
 */
const axios = require("axios");
const crypto = require("crypto");
const { MessageFlags } = require("discord.js");
const { Pool } = require("pg");
const { MSGS } = require("../utils/messages");

const INTERNAL_HTTP_BASE = process.env.INTERNAL_HTTP_BASE;
const SERVER_URL = process.env.SERVER_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DEV_ROLE_ID = process.env.DEV_ROLE_ID;
const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

const REQUIRED_REPOS = [
  "Concordium/concordium-dapp-examples",
  "Concordium/concordium-rust-smart-contracts",
  "Concordium/concordium-node",
  "Concordium/concordium-rust-sdk",
  "Concordium/concordium-node-sdk-js",
];

async function postSaveStateWithRetry(state, discordId) {
  const candidates = [];

  if (INTERNAL_HTTP_BASE) candidates.push(INTERNAL_HTTP_BASE);

  candidates.push("http://127.0.0.1:3000", "http://localhost:3000");

  if (SERVER_URL && /^https?:\/\//i.test(SERVER_URL)) {
    candidates.push(SERVER_URL);
  }

  let lastErr;
  for (const base of candidates) {
    const url = `${base.replace(/\/+$/, "")}/save-state`;
    try {
      const res = await axios.post(
        url,
        { state, discordId },
        {
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          timeout: 4000,
          validateStatus: (s) => s >= 200 && s < 500,
        }
      );
      if (res.status >= 200 && res.status < 300 && res.data?.success) {
        return true;
      }
      lastErr = new Error(`POST ${url} -> ${res.status} ${JSON.stringify(res.data)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("save-state failed (no endpoints reachable)");
}

module.exports = async function handleDevVerification(interaction, discordId, client) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    if (member.roles.cache.has(DEV_ROLE_ID)) {
      await interaction.reply({
        content: "✅ You already have the **Dev** role — no need to verify again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const state = crypto.randomBytes(16).toString("hex");

    await postSaveStateWithRetry(state, discordId);

    const authUrl =
      `https://github.com/login/oauth/authorize` +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=read:user,public_repo` +
      `&state=${encodeURIComponent(state)}`;

    await interaction.reply({
      content: `**<@&${DEV_ROLE_ID}> Role Verification**

Before proceeding, please make sure you meet the following requirements:

✅ Your GitHub account must be at least 3 months old  
✅ You must have at least 1 public repository  
✅ You must have at least 5 commits  
_(If your commits were made in a forked repository, make sure that the fork is present in your profile under your repositories. If you delete the fork, your commits will not be counted.)_
✅ You must star the following repositories:  

[**Concordium DApp Examples**](<https://github.com/Concordium/concordium-dapp-examples>)  
[**Concordium Rust Smart Contracts**](<https://github.com/Concordium/concordium-rust-smart-contracts>)  
[**Concordium Node**](<https://github.com/Concordium/concordium-node>)  
[**Concordium Rust SDK**](<https://github.com/Concordium/concordium-rust-sdk>)  
[**Concordium Node SDK (JS)**](<https://github.com/Concordium/concordium-node-sdk-js>)

🔗 **[Click Here to Verify](<${authUrl}>)**`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error("GitHub auth error:", error);
    try {
      await interaction.reply({
        content: "❌ Failed to generate GitHub auth link. Please try again later.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
  }
};

module.exports.processGithubCallback = async function ({ accessToken, discordId, discordClient }) {
  const errors = [];
  try {
    const userResponse = await axios.get("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const createdAt = new Date(userResponse.data.created_at);
    const now = new Date();
    const monthsDiff =
      (now.getFullYear() - createdAt.getFullYear()) * 12 +
      (now.getMonth() - createdAt.getMonth());
    if (monthsDiff < 3) {
      errors.push(
        `Your GitHub account is too new (${monthsDiff} months old). It must be at least 3 months old.`
      );
    }

    const reposResponse = await axios.get(userResponse.data.repos_url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (reposResponse.data.length < 1) {
      errors.push("You must have at least 1 public repository.");
    }

    let totalCommits = 0;
    for (const repo of reposResponse.data) {
      try {
        const commitsResponse = await axios.get(
          `https://api.github.com/repos/${userResponse.data.login}/${repo.name}/commits`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const ownCommits = commitsResponse.data.filter(
          (commit) => commit?.author?.login === userResponse.data.login
        );
        totalCommits += ownCommits.length;
        if (totalCommits >= 5) break;
      } catch (error) {
        console.log(`Skipping repo ${repo.name}: ${error.message}`);
      }
    }
    if (totalCommits < 5) {
      errors.push(`You have only ${totalCommits} commits. Minimum required is 5.`);
    }

    const missingStars = [];
    for (const repo of REQUIRED_REPOS) {
      try {
        await axios.get(`https://api.github.com/user/starred/${repo}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (error) {
        if (error.response && error.response.status === 404) {
          missingStars.push(
            `<a href="https://github.com/${repo}" target="_blank">${repo}</a>`
          );
        }
      }
    }
    if (missingStars.length > 0) {
      errors.push(
        `You must star the following repositories: ${missingStars.join(", ")}`
      );
    }

    const githubProfileUrl = userResponse.data.html_url;
    const isDuplicate = await module.exports.checkDuplicateGithubProfile(
      githubProfileUrl
    );
    if (isDuplicate) {
      errors.push(
        `The GitHub profile <a href="${githubProfileUrl}" target="_blank">${githubProfileUrl}</a> has already been used to verify another Discord account. Please use a different GitHub account.`
      );
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    try {
      const guild = await discordClient.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(discordId);
      const role = guild.roles.cache.get(DEV_ROLE_ID);

      if (role && member) {
        await member.roles.add(role);
        console.log(
          `[${new Date().toISOString()}][VERIFICATION] ✅ Role '${DEV_ROLE_ID}' successfully assigned to user ${discordId}`
        );

        try {
          const modChannel = await discordClient.channels.fetch(MOD_LOGS_CHANNEL_ID);
          if (modChannel?.isTextBased?.()) {
            if (typeof MSGS?.modLogsDeveloperAssigned === "function") {
              await modChannel.send(MSGS.modLogsDeveloperAssigned(DEV_ROLE_ID, discordId));
            } else {
              await modChannel.send(
                `🛠️ Developer role <@&${DEV_ROLE_ID}> assigned to <@${discordId}>.`
              );
            }
          }
        } catch (e) {
          console.warn("[dev] could not send mod log:", e?.message || e);
        }
      } else {
        console.log("⚠️ Role or user not found.");
      }
    } catch (err) {
      console.error("Error assigning role:", err);
      return {
        success: false,
        errors: ["Discord role assignment failed. Please contact a moderator."],
      };
    }

    await module.exports.saveDeveloperVerification(discordId, githubProfileUrl);

    return { success: true };
  } catch (error) {
    console.error("GitHub validation error:", error);
    return { success: false, errors: ["Unexpected error during GitHub validation."] };
  }
};

module.exports.saveDeveloperVerification = async function (discordId, githubProfile) {
  try {
    await pool.query(
      `INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type, github_profile)
       VALUES ($1, $2, $3, $4, $5)`,
      ["developer-auth", "developer-auth", discordId, "Developer", githubProfile]
    );
  } catch (err) {
    console.error("❌ Failed to save dev verification to DB:", err);
  }
};

module.exports.checkDuplicateGithubProfile = async function (githubProfileUrl) {
  try {
    const result = await pool.query(
      "SELECT 1 FROM verifications WHERE github_profile = $1 AND role_type = 'Developer'",
      [githubProfileUrl]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error("❌ Failed to check GitHub profile:", err);
    return false;
  }
};