// utils/logger.js
const levels = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const currentLevelValue = Object.prototype.hasOwnProperty.call(levels, currentLevel)
  ? levels[currentLevel]
  : levels.info;

function shouldLog(level) {
  return levels[level] <= currentLevelValue;
}

function stamp() {
  return new Date().toISOString();
}

function fmt(level, scope) {
  const lvl = level.toUpperCase();
  return scope ? `${stamp()} [${lvl}] ${scope}` : `${stamp()} [${lvl}]`;
}

function log(level, scope, ...args) {
  if (!shouldLog(level)) return;
  console.log(fmt(level, scope), ...args);
}

module.exports = {
  error: (scope, ...args) => log("error", scope, ...args),
  warn: (scope, ...args) => log("warn", scope, ...args),
  info: (scope, ...args) => log("info", scope, ...args),
  debug: (scope, ...args) => log("debug", scope, ...args),
  level: currentLevel,
};