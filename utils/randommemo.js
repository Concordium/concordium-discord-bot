// /utils/randommemo.js
/**
 * Generates a random numeric memo string.
 * - Length: 5–10 digits (inclusive), chosen randomly per call.
 * - Returns: string of digits suitable for lightweight tags/identifiers.
 * - Export: generateRandomMemo()
 */

function generateRandomMemo() {
    const length = Math.floor(Math.random() * 6) + 5;
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10);
    }
    return result;
}

module.exports = { generateRandomMemo };