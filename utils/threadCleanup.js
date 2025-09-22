// utils/threadCleanup.js
/**
 * Periodic cleanup utility for inactive private verification threads.
 * Responsibilities:
 * - Starts a single interval loop that:
 *   - Fetches a target channel by `channelId` and enumerates active threads.
 *   - Filters only `PrivateThread`s.
 *   - Determines last activity (last non-bot message timestamp, else thread creation).
 *   - Deletes threads idle longer than `THREAD_INACTIVITY_LIMIT_MS` (default 1h).
 *   - Removes associated user state from `stateMap` using the userId parsed from the thread name.
 * - Interval cadence controlled by `THREAD_CLEANUP_INTERVAL_MS` (default 60s).
 */
const { ChannelType } = require("discord.js");

const INACTIVE_THREAD_CHECK_INTERVAL = Number(process.env.THREAD_CLEANUP_INTERVAL_MS || 60000);
const THREAD_INACTIVITY_LIMIT = Number(process.env.THREAD_INACTIVITY_LIMIT_MS || 3600000);

function startInactiveThreadsCleanup({ client, stateMap, threadPrefix, channelId }) {
    if (stateMap.cleanupStarted) return;
    stateMap.cleanupStarted = true;

    setInterval(async () => {
        try {
            const now = Date.now();
            const verificationChannel = await client.channels.fetch(channelId).catch(() => null);
            if (!verificationChannel) return;

            const threads = await verificationChannel.threads.fetchActive();
            for (const [, thread] of threads.threads) {
                if (thread.type !== ChannelType.PrivateThread || !thread.name.startsWith(threadPrefix)) continue;

                const messages = await thread.messages.fetch({ limit: 100 });
                const lastUserMessage = messages.find(m => !m.author.bot);
                const lastActivityTimestamp = lastUserMessage ? lastUserMessage.createdTimestamp : thread.createdTimestamp;

                if (now - lastActivityTimestamp > THREAD_INACTIVITY_LIMIT) {
                    try {
                        await thread.delete('Automatic deletion after inactivity');
                        const userId = thread.name.split('-')[2];
                        stateMap.delete(userId);
                    } catch (err) {
                        console.error(`Error deleting inactive thread ${thread.id}:`, err);
                    }
                }
            }
        } catch (err) {
            console.error(`[${threadPrefix}] Error in inactive threads cleanup:`, err);
        }
    }, INACTIVE_THREAD_CHECK_INTERVAL);
}

module.exports = { startInactiveThreadsCleanup };