const axios = require("axios");
const { MessageFlags } = require("discord.js");
const { Pool } = require("pg");

const SERVER_URL = process.env.SERVER_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DEV_ROLE_ID = process.env.DEV_ROLE_ID;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// Main entry point for Dev role verification
module.exports = async function handleDevVerification(interaction, discordId, state, client) {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);

        // If the user already has the Dev role, skip verification
        if (member.roles.cache.has(DEV_ROLE_ID)) {
            await interaction.reply({
                content: "✅ You already have the **Dev** role — no need to verify again.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Save OAuth state and Discord ID
        await axios.post(`${SERVER_URL}/save-state`, { state, discordId });

        const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${SERVER_URL}/callback&scope=read:user,public_repo&state=${state}`;

        await interaction.reply({
            content: `**<@&${DEV_ROLE_ID}> Role Verification**

Before proceeding, please make sure you meet the following requirements:

✅ Your GitHub account must be at least 3 months old  
✅ You must have at least 1 public repository  
✅ You must have at least 5 commits  
✅ You must star the following repositories:  

[**Concordium DApp Examples**](<https://github.com/Concordium/concordium-dapp-examples>)  
[**Concordium Rust Smart Contracts**](<https://github.com/Concordium/concordium-rust-smart-contracts>)  
[**Concordium Node**](<https://github.com/Concordium/concordium-node>)  
[**Concordium Rust SDK**](<https://github.com/Concordium/concordium-rust-sdk>)  
[**Concordium Node SDK (JS)**](<https://github.com/Concordium/concordium-node-sdk-js>)

🔗 **[Click Here to Verify](<${authUrl}>)**`,
            flags: MessageFlags.Ephemeral
        });
    } catch (error) {
        console.error("GitHub auth error:", error);
        await interaction.reply({
            content: "❌ Failed to generate GitHub auth link. Please try again later.",
            flags: MessageFlags.Ephemeral
        });
    }
};

// Called from /callback to save verification data after GitHub validation
module.exports.saveDeveloperVerification = async function (discordId, githubProfile) {
    try {
        await pool.query(
            `INSERT INTO verifications (discord_id, role_type, github_profile) VALUES ($1, $2, $3)`,
            [discordId, "Dev", githubProfile]
        );
        console.log(`✅ Dev verification saved to DB for user ${discordId}`);
    } catch (err) {
        console.error("❌ Failed to save dev verification to DB:", err);
    }
};