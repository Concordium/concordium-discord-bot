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

// To avoid duplicate messages across one bot session
const notifiedDelegators = new Map();

async function getDelegationTarget(walletAddress) {
    const cmd = `${CLIENT_PATH} account show ${walletAddress} --grpc-ip ${GRPC_IP} --secure`;
    try {
        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) return reject(stderr);
                resolve(stdout);
            });
        });

        const match = output.match(/Delegation target:\s+Staking pool with ID (\d+)/i);
        return match ? match[1] : null;
    } catch (error) {
        console.warn(`❌ Failed to get delegation target for ${walletAddress}:`, error);
        return null;
    }
}

async function isValidatorSuspended(validatorId) {
    const cmd = `${CLIENT_PATH} account show ${validatorId} --grpc-ip ${GRPC_IP} --secure`;
    try {
        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) return reject(stderr);
                resolve(stdout);
            });
        });

        return /This validator is suspended/i.test(output);
    } catch (error) {
        console.warn(`❌ Failed to check status for validator ${validatorId}:`, error);
        return false;
    }
}

async function notifyDelegatorsOfSuspendedValidators(client) {
    try {
        const result = await pool.query(
            "SELECT discord_id, wallet_address FROM verifications WHERE role_type = 'Delegator'"
        );

        for (const row of result.rows) {
            const { discord_id, wallet_address } = row;

            // Skip if already notified in this session
            if (notifiedDelegators.get(wallet_address) === true) continue;

            const validatorId = await getDelegationTarget(wallet_address);
            if (!validatorId) continue;

            const suspended = await isValidatorSuspended(validatorId);
            if (!suspended) continue;

            try {
                const user = await client.users.fetch(discord_id);
                await user.send(
`🚨 Attention! The validator to which you are delegating (Validator ID: #${validatorId}) is currently suspended.  
You will not receive staking rewards while it remains in this status.  
We recommend contact your validator or switching to an active validator to continue earning rewards.`
                );
                console.log(`✅ Notified ${user.tag} about suspended validator ${validatorId}`);
                notifiedDelegators.set(wallet_address, true);
            } catch (err) {
                console.warn(`⚠️ Could not notify user ${discord_id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ Failed to scan delegators for suspended validators:', err);
    }
}

function startDelegatorSuspensionNotifier(client) {
    cron.schedule("10 9 * * *", async () => {
        console.log("⏰ Running delegator suspension scan...");
        await notifyDelegatorsOfSuspendedValidators(client);
    }, {
        timezone: "UTC"
    });
}

module.exports = {
    notifyDelegatorsOfSuspendedValidators,
    startDelegatorSuspensionNotifier
};