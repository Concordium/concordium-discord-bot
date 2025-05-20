# 🤖 Concordium Discord Verification Bot

A Discord bot for the Concordium ecosystem, providing **on-chain verification** and role management for server members: **Validators**, **Delegators**, and **Developers**.  
Supports automatic cleanup of inactive validators and delegators using on-chain activity checks.

---

## 🚀 Key Features

- **Multi-step verification flows**:
  - **Delegator:** On-chain delegation check.
  - **Validator:** On-chain validation check.
  - **Developer:** OAuth2 via GitHub, repository analysis, and role assignment.
- **Smart role assignment** after wallet or GitHub account verification.
- **Verification history in PostgreSQL** — prevents duplicates and enables auditing.
- **Private threads** for each user during verification.
- **AutoModeration integration** for increased security.
- **Secure backend:** Uses `concordium-client` and centralized management through slash commands.
- **Fully Dockerized deployment**.
- **Cleanup of inactive** validators and delegators via on-chain logic.

---

## 🛠 Requirements

- **Docker** & **Docker Compose**
- **PostgreSQL**
- `concordium-client` (installed in the container)

---

## 📁 Project Structure

```
├── bot.js # Discord bot core logic
├── server.js # Express server (GitHub OAuth + state handling)
├── Dockerfile
├── docker-compose.yml
├── .env.template # Example environment file
├── init.sql # SQL for verification table initialization
├── automodIntegration.js # Discord AutoModeration integration
├── delegators-cleanup.js # Inactive delegator cleanup
├── validators-cleanup.js # Inactive validator cleanup
├── roles/
│ ├── delegatorVerification.js # Delegator verification
│ ├── devVerification.js # Developer verification
│ └── validatorVerification.js # Validator verification
```

---

## ⚙️ Environment Configuration (`.env`)

Use `.env.template` as a starting point and rename it to `.env`.  
Make sure to fill in all required fields (Discord token, GitHub OAuth, database credentials, etc.).

```
# Discord & GitHub OAuth
SERVER_URL=
REDIRECT_URI=
CLIENT_ID=
CLIENT_SECRET=

# concordium-client
CONCORDIUM_CLIENT_PATH=\usr\bin\concordium-client

# Discord Bot
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=

# Roles
TEAM_ROLE_ID=
VALIDATOR_ROLE_ID=
DEV_ROLE_ID=
DELEGATOR_ROLE_ID=

# Channels
CLAIM_CHANNEL_ID=

# AutoModeration
AUTOMOD_RULE_ID=

# PostgreSQL
PG_USER=
PG_HOST=
PG_DATABASE=
PG_PASSWORD=
PG_PORT=
```

🐳 Docker Deployment

Check and fill your .env file as described above.
Build and run the containers:

```
docker compose build
docker compose up -d
```

View logs:

docker compose logs -f

🌐 Proxy & Security (nginx)

GitHub OAuth requires a reverse proxy with HTTPS support.
See example configuration below (replace yourdomain.com with your real domain):

```
server {
    server_name yourdomain.com;

    location /save-state {
        proxy_pass http://concordium-bot:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /callback {
        proxy_pass http://concordium-bot:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

Note:
GitHub OAuth and Discord API require HTTPS!

🧾 Slash Commands
```
/start-again-delegator — Restart delegator verification
/start-again-validator — Restart validator verification
/cleanup-inactive-validators — Remove validator roles from inactive users (on-chain check)
/cleanup-inactive-delegators — Remove delegator roles from inactive users (on-chain check)
```
🗄️ Database Schema

Table verifications (see init.sql):
Field	Type	Description
id	SERIAL	Primary key
tx_hash	TEXT	Transaction hash
wallet_address	TEXT	Concordium wallet address
discord_id	TEXT	User’s Discord ID
role_type	TEXT	Validator, Delegator, Developer
verified_at	TIMESTAMP	Verification timestamp
github_profile	TEXT	GitHub profile (for developer flow)
📞 Support & Contributions

Pull requests are welcome!
For major changes, please open an issue first to discuss your proposal.