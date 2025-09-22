-- VERIFICATIONS: master record of users who completed a role verification
-- (Validator / Delegator / Developer). Stores wallet, Discord ID, result,
-- and state used by the notification system.
CREATE TABLE IF NOT EXISTS verifications (
    id SERIAL PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    role_type TEXT NOT NULL CHECK (role_type = ANY (ARRAY['Validator', 'Delegator', 'Developer'])),
    is_suspended TEXT CHECK (is_suspended IN ('yes', 'no', 'suspension_is_pending')),
    delegation_target TEXT,
    validator_id INTEGER,
    verified_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    github_profile TEXT,
    last_notified_suspended TEXT CHECK (last_notified_suspended IN ('yes', 'no', 'suspension_is_pending')),
    last_notified_delegation_target TEXT
);

-- VALIDATOR COMMISSIONS: current pool commission rates (block/tx),
-- the last check timestamp, and the last “notified” values used to detect changes.
CREATE TABLE IF NOT EXISTS validator_commissions (
    validator_id INTEGER PRIMARY KEY,
    baking_rate NUMERIC NOT NULL,
    transaction_fee_rate NUMERIC NOT NULL,
    last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_notified_baking_rate NUMERIC,
    last_notified_transaction_fee_rate NUMERIC
);

-- NOTIFICATION PREFS: user-level toggle for receiving DMs from the bot.
-- Defaults to receive = TRUE until a user explicitly opts out.
CREATE TABLE IF NOT EXISTS notification_prefs (
  discord_id  TEXT PRIMARY KEY,
  receive     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- VALIDATOR-DELEGATORS: on-chain mapping of validator ↔ delegator with the
-- delegator’s account address and first/last seen timestamps.
CREATE TABLE IF NOT EXISTS validator_delegators (
  validator_id     INTEGER      NOT NULL,
  delegator_id     INTEGER      NOT NULL,
  account_address  TEXT         NOT NULL,
  first_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (validator_id, delegator_id)
);

-- Indexes to speed up lookups by validator and by delegator.
CREATE INDEX IF NOT EXISTS idx_validator_delegators_validator
  ON validator_delegators(validator_id);

CREATE INDEX IF NOT EXISTS idx_validator_delegators_delegator
  ON validator_delegators(delegator_id);