// modules/member-leave-handler.js
/**
 * Cleans up DB records and logs when a Discord member leaves.
 * Responsibilities:
 * - Queries `verifications` by discord_id; if any:
 *   • For Validator rows, deletes corresponding `validator_commissions` entries.
 *   • Deletes all `verifications` rows for the user and logs the count.
 * - Posts a summary to the moderators log channel (if configured), mentioning any roles the user held
 *   (<@&VALIDATOR_ROLE_ID>, <@&DELEGATOR_ROLE_ID>, <@&DEV_ROLE_ID>).
 */
const { Pool } = require('pg');

const {
  PG_USER,
  PG_HOST,
  PG_DATABASE,
  PG_PASSWORD,
  PG_PORT,
  MOD_LOGS_CHANNEL_ID,
  VALIDATOR_ROLE_ID,
  DELEGATOR_ROLE_ID,
  DEV_ROLE_ID,
} = process.env;

const pool = new Pool({
  user: PG_USER,
  host: PG_HOST,
  database: PG_DATABASE,
  password: PG_PASSWORD,
  port: PG_PORT
});

async function handleMemberLeave(member) {
  const discordId = member.user.id;

  try {
    const result = await pool.query(
      `SELECT wallet_address, role_type, validator_id
         FROM verifications
        WHERE discord_id = $1`,
      [discordId]
    );

    if (result.rows.length === 0) {
      console.log(`👋 User ${discordId} left, no verification records to remove.`);
      return;
    }

    const validatorIds = [
      ...new Set(
        result.rows
          .filter(r => r.role_type === 'Validator')
          .map(r => Number(r.validator_id))
          .filter(Number.isFinite)
      )
    ];

    for (const row of result.rows) {
      const { role_type, validator_id } = row;
      if (role_type === 'Validator' && Number.isFinite(Number(validator_id))) {
        try {
          await pool.query(
            `DELETE FROM validator_commissions WHERE validator_id = $1`,
            [Number(validator_id)]
          );
          console.log(`🧹 Removed validator_commissions entry for validator_id: ${validator_id}`);
        } catch (err) {
          console.error(`❌ Failed to remove validator_commissions for ID ${validator_id}:`, err.message);
        }
      }
    }

    if (validatorIds.length > 0) {
      try {
        await pool.query(
          `DELETE FROM validator_delegators WHERE validator_id = ANY($1::int[])`,
          [validatorIds]
        );
        console.log(`🧹 Removed validator_delegators for validator_id(s): ${validatorIds.join(', ')}`);
      } catch (err) {
        console.error('❌ Failed to batch-remove validator_delegators:', err.message);
      }
    }

    const del = await pool.query(`DELETE FROM verifications WHERE discord_id = $1`, [discordId]);
    console.log(`✅ Removed ${del.rowCount} verification record(s) for discord_id: ${discordId}`);

    const hadValidator = result.rows.some(r => r.role_type === 'Validator');
    const hadDelegator = result.rows.some(r => r.role_type === 'Delegator');
    const hadDeveloper = result.rows.some(r => r.role_type === 'Developer');

    const roleMentions = [];
    if (hadValidator && VALIDATOR_ROLE_ID) roleMentions.push(`<@&${VALIDATOR_ROLE_ID}>`);
    if (hadDelegator && DELEGATOR_ROLE_ID) roleMentions.push(`<@&${DELEGATOR_ROLE_ID}>`);
    if (hadDeveloper && DEV_ROLE_ID)       roleMentions.push(`<@&${DEV_ROLE_ID}>`);

    if (MOD_LOGS_CHANNEL_ID && roleMentions.length > 0) {
      const rolesText = roleMentions.join(' and ');
      const msg = `User <@${discordId}> has left the server; removed verification records for ${rolesText}.`;

      try {
        const modCh = await member.client.channels.fetch(MOD_LOGS_CHANNEL_ID);
        if (modCh?.isTextBased?.()) {
          await modCh.send(msg);
        } else {
          console.warn('⚠️ MOD_LOGS_CHANNEL_ID is not a text-based channel or cannot be used to send messages.');
        }
      } catch (err) {
        console.error('❌ Failed to send leave notice to mod logs:', err?.message || err);
      }
    }
  } catch (err) {
    console.error(`❌ Error handling member leave for ${discordId}:`, err.message);
  }
}

module.exports = {
  handleMemberLeave
};