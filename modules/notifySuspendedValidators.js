const { exec } = require('child_process');
const { Pool } = require('pg');
const cron = require('node-cron');

const CLIENT_PATH = process.env.CONCORDIUM_CLIENT_PATH;
const GRPC_IP = process.env.GRPC_IP;

const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

// Store addresses we've already notified in this session
const notifiedValidators = new Map();

async function isValidatorSuspended(walletAddress) {
    const cmd = `${CLIENT_PATH} account show ${walletAddress} --grpc-ip ${GRPC_IP} --secure`;
    try {
        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) return reject(stderr);
                resolve(stdout);
            });
        });

        return /This validator is suspended/i.test(output);
    } catch (error) {
        console.warn(`❌ Failed to check status for validator ${walletAddress}:`, error);
        return false;
    }
}

async function notifySuspendedValidators(client) {
    try {
        const result = await pool.query(
            "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Validator'"
        );

        for (const row of result.rows) {
            const { discord_id, wallet_address } = row;

            // Skip if already notified
            if (notifiedValidators.get(wallet_address) === true) continue;

            const suspended = await isValidatorSuspended(wallet_address);
            if (!suspended) continue;

            try {
                const user = await client.users.fetch(discord_id);
                await user.send(
`🚨 Attention! Your validator account (Address: ${wallet_address}) is currently suspended.  
You will not receive rewards while your validator remains in this status.  
Please review the status and consider reactivating your validator as soon as possible.

🔧 [Learn how to unsuspend your validator](https://docs.concordium.com/en/mainnet/docs/mobile-wallet/suspend-unsuspend-validator.html)`
                );

                console.log(`✅ Notified validator ${user.tag} about suspension`);
                notifiedValidators.set(wallet_address, true);
            } catch (err) {
                console.warn(`⚠️ Could not notify user ${discord_id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ Failed to scan validator accounts:', err);
    }
}

function startSuspendedValidatorNotifier(client) {
    cron.schedule("10 9 * * *", async () => {
        console.log("⏰ Running suspended validator notifier (10:30 UTC)...");
        await notifySuspendedValidators(client);
    }, {
        timezone: "UTC"
    });
}

module.exports = {
    notifySuspendedValidators,
    startSuspendedValidatorNotifier
};