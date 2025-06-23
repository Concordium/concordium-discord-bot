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

// List of required GitHub repositories to star
const REQUIRED_REPOS = [
    "Concordium/concordium-dapp-examples",
    "Concordium/concordium-rust-smart-contracts",
    "Concordium/concordium-node",
    "Concordium/concordium-rust-sdk",
    "Concordium/concordium-node-sdk-js"
];

// Entry point for Dev role verification from Discord interaction
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

        // Save OAuth state and Discord ID for later callback validation
        await axios.post(`${SERVER_URL}/save-state`, { state, discordId });

        const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${SERVER_URL}/callback&scope=read:user,public_repo&state=${state}`;

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

// Main validation logic for GitHub profile, called from the OAuth callback in server.js
module.exports.processGithubCallback = async function ({ accessToken, discordId, discordClient }) {
    const errors = [];
    try {
        // Fetch GitHub user profile
        const userResponse = await axios.get("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        // Check account age
        const createdAt = new Date(userResponse.data.created_at);
        const now = new Date();
        const monthsDiff = (now.getFullYear() - createdAt.getFullYear()) * 12 + (now.getMonth() - createdAt.getMonth());

        if (monthsDiff < 3) {
            errors.push(`Your GitHub account is too new (${monthsDiff} months old). It must be at least 3 months old.`);
        }

        // Fetch user's repositories
        const reposResponse = await axios.get(userResponse.data.repos_url, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (reposResponse.data.length < 1) {
            errors.push("You must have at least 1 public repository.");
        }

        // Count total commits across all repos (stop at 5)
        let totalCommits = 0;
        for (const repo of reposResponse.data) {
            try {
                const commitsResponse = await axios.get(
                    `https://api.github.com/repos/${userResponse.data.login}/${repo.name}/commits`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );

                const ownCommits = commitsResponse.data.filter(
                    commit => commit.author && commit.author.login === userResponse.data.login
                );

                totalCommits += ownCommits.length;
                if (totalCommits >= 5) break;
            } catch (error) {
                // Skip repo if error (e.g., empty or forked repo with no commits)
                console.log(`Skipping repo ${repo.name}: ${error.message}`);
            }
        }

        if (totalCommits < 5) {
            errors.push(`You have only ${totalCommits} commits. Minimum required is 5.`);
        }

        // Check for required stars
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

        // Check for duplicate GitHub profile
        const githubProfileUrl = userResponse.data.html_url;
        const isDuplicate = await module.exports.checkDuplicateGithubProfile(githubProfileUrl);
        if (isDuplicate) {
            errors.push(`The GitHub profile <a href="${githubProfileUrl}" target="_blank">${githubProfileUrl}</a> has already been used to verify another Discord account. Please use a different GitHub account.`);
        }

        // If there are any errors, return them
        if (errors.length > 0) {
            return { success: false, errors };
        }

        // Assign Dev role to the user in Discord
        try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(discordId);
            const role = guild.roles.cache.get(DEV_ROLE_ID);

            if (role && member) {
                await member.roles.add(role);
                console.log(`✅ Role '${DEV_ROLE_ID}' successfully assigned to user ${discordId}`);
            } else {
                console.log("⚠️ Role or user not found.");
            }
        } catch (err) {
            console.error("Error assigning role:", err);
            return { success: false, errors: ["Discord role assignment failed. Please contact a moderator."] };
        }

        // Save verification in the database
        await module.exports.saveDeveloperVerification(discordId, githubProfileUrl);

        // Return success if all checks passed
        return { success: true };
    } catch (error) {
        console.error("GitHub validation error:", error);
        return { success: false, errors: ["Unexpected error during GitHub validation."] };
    }
};

// Save successful developer verification to the database
module.exports.saveDeveloperVerification = async function (discordId, githubProfile) {
    try {
        await pool.query(
            `INSERT INTO verifications (tx_hash, wallet_address, discord_id, role_type, github_profile) VALUES ($1, $2, $3, $4, $5)`,
            ['developer-auth', 'developer-auth', discordId, 'Developer', githubProfile]
        );
        console.log(`✅ Dev verification saved to DB for user ${discordId}`);
    } catch (err) {
        console.error("❌ Failed to save dev verification to DB:", err);
    }
};

// Check for duplicate GitHub profile in the database
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
