require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");
const devverification = require("./roles/devVerification");

const app = express();
const PORT = 3000;

// PostgreSQL configuration
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// Discord bot configuration
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DEV_ROLE_ID = process.env.DEV_ROLE_ID;

// GitHub OAuth configuration
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Store state for each user
const authRequests = new Map();

// Launch Discord bot
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});
discordClient.login(DISCORD_BOT_TOKEN);

// Serve static files (optional)
app.use(express.static(path.join(__dirname)));

// Enable JSON parsing
app.use(express.json());

// Save state from frontend
app.post("/save-state", (req, res) => {
    const { state, discordId } = req.body;

    if (!state || !discordId) {
        return res.status(400).json({ error: "Invalid request" });
    }

    authRequests.set(state, discordId);
    res.json({ success: true });
});

// OAuth GitHub link
app.get("/auth/github", (req, res) => {
    const { state } = req.query;

    if (!state) {
        return res.status(400).send("Error: 'state' is missing.");
    }

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=read:user,public_repo&state=${state}`;
    res.redirect(authUrl);
});

// GitHub OAuth callback
app.get("/callback", async (req, res) => {
    try {
        const { code, state, error, error_description } = req.query;

        // Handle user denying access or other GitHub OAuth errors
        if (error === "access_denied") {
            return res.send(`
                <h1 style="font-size:2.2em; color:#c0392b;">Access Denied</h1>
                <p style="font-size:1.15em;">
                    You have denied authorization via GitHub.<br>
                    <b>Developer verification cannot be completed without authorization.</b>
                </p>
                <p style="font-size:1.05em; color:#222;">
                    Please return to Discord and initiate the verification process again using the appropriate menu.
                </p>
            `);
        }

        if (!authRequests.has(state)) {
            return res.send(`
                <h1 style="font-size:2.2em;">Verification session expired!</h1>
                <p>To restart the verification process, please initiate it again via Discord.</p>
            `);
        }

        const discordId = authRequests.get(state);
        authRequests.delete(state);

        // Get GitHub access token
        const tokenResponse = await axios.post(
            "https://github.com/login/oauth/access_token",
            {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code
            },
            { headers: { Accept: "application/json" } }
        );

        const accessToken = tokenResponse.data.access_token;
        if (!accessToken) {
            return res.send(`
                <h1 style="font-size:2.2em; color:#c0392b;">GitHub OAuth Error</h1>
                <p style="font-size:1.15em;">
                    Failed to retrieve access token.<br>
                    Please try again, and be sure to grant access to your GitHub profile.
                </p>
                <p style="font-size:1.05em; color:#222;">
                    Please return to Discord and initiate the verification process again using the appropriate menu.
                </p>
            `);
        }

        // All GitHub profile validation logic moved to devverification.js
        const result = await devverification.processGithubCallback({
            accessToken,
            discordId,
            discordClient
        });

        if (!result.success) {
            return res.send(`
                <h1 style="font-size:2em; color:#c0392b;">❌ Verification failed!</h1>
                <p>Please fix the following issues:</p>
                <ol>${result.errors.map(error => `<li>${error}</li>`).join("")}</ol>
            `);
        }

        res.send(`
            <h1 style="font-size:2em; color:green;">✅ Verification successful!</h1>
            <p>You can now close this page.</p>
        `);
    } catch (error) {
        console.error("Authentication error:", error);
        res.status(500).send(`
            <h1 style="font-size:2.2em; color:#c0392b;">Server error occurred</h1>
            <p>Please try again later or contact support.</p>
        `);
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
});