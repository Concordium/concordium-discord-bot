# 🤖 Concordium Discord Verification Bot

This project is a Discord bot built for the Concordium ecosystem to securely verify community members as **Validators**, **Delegators**, or **Developers**, and assign them appropriate roles within a Discord server.

---

## 🚀 Features

- ✅ **Multi-step verification flows** for:
  - Delegators (on-chain delegation + transaction check)
  - Validators (stake verification)
  - Developers (GitHub OAuth, repo analysis, Discord role assignment)
- 📡 **OAuth2 GitHub integration** with redirect and state tracking
- 🧠 **Smart role assignment** after verifying wallet or GitHub account
- 🗃 **PostgreSQL-backed verification log** to prevent duplicates and track history
- 🔐 **Secure backend** using `concordium-client` and controlled through slash commands
- 💬 **Private threads** are created per-user for isolated verification

---

## 🛠 Requirements

- Node.js 18+
- Docker & Docker Compose (for containerized deployment)
- PostgreSQL
- `concordium-client` binary installed (inside container)

---

## 📁 Folder Structure

```
.
├── bot.js                   # Discord bot core logic
├── server.js                # Express server (GitHub OAuth + state handling)
├── Dockerfile
├── docker-compose.yml
├── .env.template            # Example environment file
├── init.sql                 # SQL to initialize verifications table
├── roles/
│   ├── delegatorVerification.js
│   ├── devVerification.js
│   └── validatorVerification.js
└── utils/
    └── automodIntegration.js
```

---

## ⚙️ Environment Configuration (`.env`)

Use `.env.template` as a starting point and rename it to `.env`.

```
# 🔧 Server and Github OAuth Configuration

SERVER_URL=https://yourdomain.com
REDIRECT_URI=https://yourdomain.com/callback
CLIENT_ID=
CLIENT_SECRET=

# concordium-client

CONCORDIUM_CLIENT_PATH=/usr/bin/concordium-client

# 🤖 Discord Bot Configuration

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

# 🗄️ PostgreSQL Database Configuration

PG_USER=
PG_HOST=
PG_DATABASE=
PG_PASSWORD=
PG_PORT=
```
⚠️ Never commit your .env file. Use .env.template for sharing.


## 🧾 Slash Commands

The bot automatically registers:
```
/start-again-delegator

/start-again-validator
```
These allow users to restart verification if needed.

## 🐳 Docker Deployment

To build and run:
```
docker compose build
docker compose up -d
```

To connect to the PostgreSQL database:
```
docker exec -it postgres-db psql -U botuser -d concordium_verification
```

## 🌐 nginx Configuration (Required for GitHub OAuth)

To properly handle GitHub OAuth redirects, your domain must expose the following paths:
```
server {
    server_name yourdomain.com;

    location /save-state {
        proxy_pass http://172.20.0.3:3000; # Or use internal Docker IP
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /callback {
        proxy_pass http://172.20.0.3:3000;
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

📌 Replace yourdomain.com with your actual domain.

⚠️ HTTPS is mandatory for GitHub OAuth and Discord API to work properly.

## 📞 Support & Contributions

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.