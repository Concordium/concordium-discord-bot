CREATE TABLE IF NOT EXISTS verifications (
    id SERIAL PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    role_type TEXT NOT NULL CHECK (role_type = ANY (ARRAY['Validator', 'Delegator', 'Developer'])),
    verified_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    github_profile TEXT
);