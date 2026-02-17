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

  const prefix = fmt(level, scope);

  if (level === "error") {
    console.error(prefix, ...args);
  } else if (level === "warn") {
    console.warn(prefix, ...args);
  } else if (level === "debug") {
    console.debug(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

module.exports = {
  error: (scope, ...args) => log("error", scope, ...args),
  warn: (scope, ...args) => log("warn", scope, ...args),
  info: (scope, ...args) => log("info", scope, ...args),
  debug: (scope, ...args) => log("debug", scope, ...args),
  level: currentLevel,
};