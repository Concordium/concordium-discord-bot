require("dotenv").config(); // Load environment variables

const express = require("express");
const axios = require("axios");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");

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

// Required GitHub repositories to be starred
const REQUIRED_REPOS = [
    "Concordium/concordium-dapp-examples",
    "Concordium/concordium-rust-smart-contracts",
    "Concordium/concordium-node",
    "Concordium/concordium-rust-sdk",
    "Concordium/concordium-node-sdk-js"
];

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
        const { code, state } = req.query;

        if (!authRequests.has(state)) {
            return res.send("<h1>Verification session expired!</h1><p>To restart the verification process, please initiate it again via Discord.</p>");
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
            return res.send("Error: Failed to retrieve access token.");
        }

        // Validate GitHub user
        const validationErrors = await verifyGitHubUser(accessToken);
        if (validationErrors.length > 0) {
            return res.send(`<h1>❌ Verification failed!</h1><p>Please fix the following issues:</p><ol>${validationErrors.map(error => `<li>${error}</li>`).join("")}</ol>`);
        }

        // Assign role in Discord
        const userResponse = await axios.get("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const githubProfileUrl = userResponse.data.html_url;

        const isDuplicate = await checkDuplicateGithubProfile(githubProfileUrl);
        if (isDuplicate) {
            return res.send(`<h1>⚠️ GitHub profile already used</h1><p>The GitHub profile <a href="${githubProfileUrl}" target="_blank">${githubProfileUrl}</a> has already been used to verify another Discord account. Please use a different GitHub account.</p>`);
        }

        await assignRoleToUser(discordId);
        await saveVerificationToDB(discordId, githubProfileUrl);

        res.send("<h1>✅ Verification successful! You can now close this page.</h1>");
    } catch (error) {
        console.error("Authentication error:", error);
        res.status(500).send("Server error occurred.");
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
});

// Validate GitHub user
async function verifyGitHubUser(accessToken) {
    const errors = [];

    try {
        const userResponse = await axios.get("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const reposResponse = await axios.get(userResponse.data.repos_url, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Account age check
        const createdAt = new Date(userResponse.data.created_at);
        const now = new Date();
        const monthsDiff = (now.getFullYear() - createdAt.getFullYear()) * 12 + (now.getMonth() - createdAt.getMonth());

        if (monthsDiff < 3) {
            errors.push(`Your GitHub account is too new (${monthsDiff} months old). It must be at least 3 months old.`);
        }

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

                totalCommits += commitsResponse.data.length;
                if (totalCommits >= 5) break;
            } catch (error) {
                console.log(`Skipping repo ${repo.name}: ${error.message}`);
            }
        }

        if (totalCommits < 5) {
            errors.push(`You have only ${totalCommits} commits. Minimum required is 5.`);
        }

        // Required stars
        const missingStars = [];
        for (const repo of REQUIRED_REPOS) {
            try {
                await axios.get(
                    `https://api.github.com/user/starred/${repo}`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    missingStars.push(`<a href="https://github.com/${repo}" target="_blank">${repo}</a>`);
                }
            }
        }

        if (missingStars.length > 0) {
            errors.push(`You must star the following repositories: ${missingStars.join(", ")}`);
        }

        return errors;
    } catch (error) {
        console.error("GitHub validation error:", error);
        return ["Unexpected error during GitHub validation."];
    }
}

// Assign dev role in Discord
async function assignRoleToUser(discordId) {
    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
        const member = await guild.members.fetch(discordId);
        const role = guild.roles.cache.get(DEV_ROLE_ID);

        if (role && member) {
            await member.roles.add(role);
            console.log(`✅ Role '${DEV_ROLE_ID}' successfully assigned to user ${discordId}`);
        } else {
            console.log("⚠️ Role or user not found.");
        }
    } catch (error) {
        console.error("Error assigning role:", error);
    }
}

// Save verification to PostgreSQL
async function saveVerificationToDB(discordId, githubProfileUrl) {
    try {
        await pool.query(
            `INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type, verified_at, github_profile)
             VALUES ($1, $2, $3, $4, NOW(), $5)`,
            ["developer-auth", "developer-auth", discordId, "Developer", githubProfileUrl]
        );
        console.log(`📝 Saved Developer verification for user ${discordId}`);
    } catch (err) {
        console.error("❌ Failed to save Developer verification:", err);
    }
}

// Check if GitHub profile already used
async function checkDuplicateGithubProfile(githubProfileUrl) {
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
}