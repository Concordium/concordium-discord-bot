// modules/notificationPrefs.js
/**
 * Manages per-user DM notification preferences backed by Postgres.
 * Responsibilities:
 * - isNotificationsEnabled(discordId): returns boolean; defaults to ON when no record exists.
 * - setNotificationPreference(discordId, "on"|"off"|boolean): UPSERTs into `notification_prefs` with timestamp.
 * - handleReceiveNotifications(interaction): slash-command handler for /receive-notifications (on/off),
 *   replies ephemerally using MSGS.notificationsTurnedOn/Off() if available.
 * - Exports alias getNotificationPreference → isNotificationsEnabled.
 */
const { Pool } = require("pg");
const { MSGS } = require("../utils/messages");

const {
  PG_USER, PG_HOST, PG_DATABASE, PG_PASSWORD, PG_PORT,
} = process.env;

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT,
});

async function isNotificationsEnabled(discordId) {
  const id = String(discordId);
  const res = await pool.query(
    "SELECT receive FROM notification_prefs WHERE discord_id::text = $1::text LIMIT 1",
    [id]
  );
  if (res.rowCount === 0) return true;
  return res.rows[0].receive === true;
}

async function setNotificationPreference(discordId, stateOrBool) {
  const id = String(discordId);
  const receive = typeof stateOrBool === "string"
    ? stateOrBool.toLowerCase() === "on"
    : !!stateOrBool;

  await pool.query(
    `INSERT INTO notification_prefs (discord_id, receive, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (discord_id)
     DO UPDATE SET receive = EXCLUDED.receive,
                   updated_at = CURRENT_TIMESTAMP`,
    [id, receive]
  );
}

async function handleReceiveNotifications(interaction) {
  try {
    const state = interaction.options.getString("state", true);
    await setNotificationPreference(interaction.user.id, state);

    const on = state.toLowerCase() === "on";
    const msg = on
      ? (typeof MSGS.notificationsTurnedOn === "function"
          ? MSGS.notificationsTurnedOn()
          : "🔔 Personal notifications are now ON.")
      : (typeof MSGS.notificationsTurnedOff === "function"
          ? MSGS.notificationsTurnedOff()
          : "🔕 Personal notifications are now OFF.");

    await interaction.reply({ content: msg, flags: 64 });
  } catch (e) {
    console.error("[prefs] /receive-notifications failed:", e);
    try {
      await interaction.reply({
        content: "❌ Failed to update your preference. Please try again later.",
        flags: 64,
      });
    } catch {}
  }
}

module.exports = {
  isNotificationsEnabled,
  setNotificationPreference,
  handleReceiveNotifications,
  getNotificationPreference: isNotificationsEnabled,
};