# Discord Bot

This repository contains a Discord bot designed for community management and blockchain integration within the **Concordium ecosystem**.  
The bot helps automate verification, assign roles, monitor validator and delegator activity, and deliver timely updates to community members directly in Discord.

---

## Purpose

The main goal of this bot is to connect a Discord community with real-time data and activities happening on the Concordium blockchain.  
It ensures that users are accurately verified, their roles reflect their on-chain status, and they remain informed about important updates related to validators, delegators, and developers.

By automating these tasks, the bot reduces manual workload for moderators, improves transparency, and provides a more reliable experience for participants in the Concordium ecosystem.

---

## Core Features

### 1. **User Verification**
- Supports verification for three primary community roles:
  - **Validator**
  - **Delegator**
  - **Developer**
- Uses blockchain queries to confirm authenticity before assigning roles.  
- Stores verification data in PostgreSQL for consistency and auditability.

### 2. **Automated Role Assignment**
- Assigns Discord roles based on a user’s on-chain status.  
- Revokes or adjusts roles automatically if conditions change.  

### 3. **Notifications**
- Sends automated alerts to verified users, such as:
  - Validator suspension events.  
  - Commission changes in validator pools.  
  - Updates in delegation targets for delegators.  
- Direct messages can be personalized, and users can opt in or out via notification preferences.  
- Helps community members act quickly when important changes occur.

### 4. **Monitoring and Logging**
- Continuously tracks blockchain events (transactions, validator lists, pool status).  
- Keeps logs of role assignments, status changes, and alerts.  
- Provides a reliable history for moderators and developers.

### 5. **Community Management Tools**
- Thread cleanup and integration with Discord’s AutoMod system.  
- Automatic removal of roles and database entries if a user leaves the server.  
- Flexible configuration for different communities within the same ecosystem.

### 6. **Database Integration**
- PostgreSQL schema (`init.sql`) defines multiple tables:
  - **verifications** — stores user identities, roles, and statuses.  
  - **validator_commissions** — tracks commission rates and changes.  
  - **notification_prefs** — manages user preferences for receiving alerts.  
  - **validator_delegators** — maps delegators to their validators.  
- Database ensures persistence, consistency, and traceability across all features.

---

## Benefits

- **Automation** — Reduces manual intervention in assigning roles and notifying members.  
- **Accuracy** — Keeps Discord roles synchronized with real blockchain data.  
- **Transparency** — Ensures users understand why they have certain roles and when changes occur.  
- **Community Trust** — Strengthens confidence by linking on-chain identity to Discord presence.  
- **Scalability** — Works across small and large communities alike, supporting many validators and delegators.  

---

## Example Use Cases

1. **A validator is suspended**  
   The bot updates the validator’s role in Discord, marks the suspension in the database, and notifies delegators so they can react promptly.

2. **A delegator changes validator pools**  
   The bot detects the change, updates their stored delegation target, and informs the delegator.

3. **A new developer joins**  
   After GitHub verification, the bot grants them the *Developer* role and links their account.

4. **A member leaves the Discord server**  
   Their records are automatically cleaned from the database, ensuring data consistency.

---

## High-Level Architecture

- **Discord Client** — Listens for commands, role updates, and user interactions.  
- **Express Server** — Provides API endpoints and handles OAuth-based integrations.  
- **Database Layer** — PostgreSQL stores verification data, preferences, and validator/delegator mappings.  
- **Blockchain Integration** — Queries Concordium chain data to ensure real-time accuracy.  
- **Automation Scripts** — Handle migration, imports, and backfilling legacy records.  

---

This bot is built to serve as a **bridge between Discord communities and the Concordium blockchain**, offering transparency, automation, and reliability.  
It enables users to confidently engage in community activities while ensuring their on-chain status is always reflected within the server.  

By combining real-time monitoring, automated notifications, and verification, the bot enhances trust, reduces friction, and helps keep the community organized and informed.

---
