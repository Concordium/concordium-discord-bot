/**
 * Resilient async retry helpers for Node.js.
 * Responsibilities:
 * - delay(ms): Promise-based sleep.
 * - retryAsync(fn, retries=2, delayMs=600): wraps any async fn with fixed-delay retries, logs warnings, rethrows on final failure.
 * - runCommandWithRetry(cmd, retries=2, delayMs=600): executes a shell command via child_process.exec with retry; resolves stdout or rejects on error/stderr.
 * Intended to harden CLI/gRPC/network calls against transient failures.
 */
const { exec } = require("child_process");

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryAsync(fn, retries = 2, delayMs = 600) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            if (attempt > retries) throw err;
            console.warn(`⏳ Retry attempt #${attempt} after error:`, err && err.message ? err.message : err);
            await delay(delayMs);
        }
    }
}

async function runCommandWithRetry(cmd, retries = 2, delayMs = 600) {
    return await retryAsync(() => new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) return reject(stderr || err);
            resolve(stdout);
        });
    }), retries, delayMs);
}

module.exports = {
    delay,
    retryAsync,
    runCommandWithRetry,
};