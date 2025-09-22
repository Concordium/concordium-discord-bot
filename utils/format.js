// utils/format.js
/**
 * Format a decimal rate (e.g., 0.00005) as a percentage string with dynamic precision.
 * Examples:
 *  0.15      -> "15%"
 *  0.005     -> "0.5%"
 *  0.00005   -> "0.005%"
 * Trailing zeros are trimmed: "0.500%" -> "0.5%".
 */
function formatPercent(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return "unknown";
  const p = r * 100;          // decimal → percent
  const ap = Math.abs(p);

  // Dynamic decimals so tiny rates are shown precisely but remain readable:
  // >= 1% → 2 dp, 0.1–<1% → 3 dp, 0.01–<0.1% → 4 dp, <0.01% → 5 dp
  let decimals = 2;
  if (ap < 0.01) decimals = 5;
  else if (ap < 0.1) decimals = 4;
  else if (ap < 1) decimals = 3;

  let s = p.toFixed(decimals);
  s = s.replace(/\.?0+$/, ""); // trim trailing zeros and optional dot
  return `${s}%`;
}

module.exports = { formatPercent };