/**
 * Express-based API & GitHub OAuth gateway for the Discord bot.
 * Responsibilities:
 * - Boots a lightweight web server (static files + JSON) with a health check at /healthz.
 * - Manages GitHub OAuth for developer verification:
 *   - /auth/github → redirects to GitHub authorization with a state token.
 *   - /callback → exchanges code for an access token, invokes devVerification.processGithubCallback,
 *     and returns human-readable success/failure pages.
 *   - /save-state → stores (state → discordId) to tie OAuth callbacks to Discord users.
 * - Initializes a minimal Discord.js client (guild + member intents) used during verification.
 * - Reads configuration from environment (PORT, DISCORD_BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI).
 * - Starts the HTTP server when run directly; exports { app, discordClient } for reuse.
 * - Includes basic error handling for server events and process-level exceptions.
 */
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const devverification = require("./roles/devVerification");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const authRequests = new Map();

// Shared secret authenticating the internal /save-state endpoint. Without it,
// anyone who can reach the port could overwrite the OAuth state -> discordId
// mapping and hijack another user's verification flow.
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// OAuth state tokens must be short-lived: stale entries would allow replays of
// old verification links.
const STATE_TTL_MS = Number(process.env.STATE_TTL_MS || 10 * 60 * 1000);

function pruneExpiredStates(now = Date.now()) {
  for (const [state, entry] of authRequests) {
    if (now - entry.createdAt > STATE_TTL_MS) authRequests.delete(state);
  }
}
setInterval(() => pruneExpiredStates(), STATE_TTL_MS).unref?.();

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
discordClient
  .login(DISCORD_BOT_TOKEN)
  .then(() => console.log("✅ server.js Discord client logged in"))
  .catch((e) => console.error("❌ server.js Discord login failed:", e));

app.use(express.static(path.join(__dirname)));

app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/save-state", (req, res) => {
  try {
    // Require the shared internal secret when configured, so this endpoint cannot
    // be abused to fixate an OAuth state onto an arbitrary Discord account.
    if (INTERNAL_API_SECRET) {
      const provided = req.get("x-internal-secret");
      if (provided !== INTERNAL_API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
    } else {
      console.warn(
        "WARNING: INTERNAL_API_SECRET is not set; /save-state is unauthenticated."
      );
    }

    const { state, discordId } = req.body || {};
    // Basic format validation: the state is generated server-side as 32 hex chars
    // and the discordId is a snowflake (numeric string). Reject anything else to
    // keep the map free of attacker-chosen junk.
    if (
      typeof state !== "string" ||
      !/^[a-f0-9]{32}$/.test(state) ||
      typeof discordId !== "string" ||
      !/^\d{5,25}$/.test(discordId)
    ) {
      return res.status(400).json({ success: false, error: "Invalid request" });
    }
    pruneExpiredStates();
    // Do not allow overwriting a live state token: a state maps to exactly one
    // Discord user for its whole lifetime.
    if (authRequests.has(state)) {
      return res.status(409).json({ success: false, error: "State already in use" });
    }
    authRequests.set(state, { discordId, createdAt: Date.now() });
    return res.json({ success: true });
  } catch (e) {
    console.error("save-state error:", e);
    return res.status(500).json({ success: false });
  }
});

app.get("/auth/github", (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).send("Error: 'state' is missing.");
  const authUrl =
    `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=read:user,public_repo&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error === "access_denied") {
      return res.send(`
        <h1 style="font-size:2.2em; color:#c0392b;">Access Denied</h1>
        <p style="font-size:1.15em;">
          You have denied authorization via GitHub.<br>
          <b>Developer verification cannot be completed without authorization.</b>
        </p>
        <p style="font-size:1.05em; color:#222;">
          Please return to Discord and initiate the verification process again using the appropriate menu.
        </p>
      `);
    }

    if (!authRequests.has(state)) {
      return res.send(`
        <h1 style="font-size:2.2em;">Verification session expired!</h1>
        <p>To restart the verification process, please initiate it again via Discord.</p>
      `);
    }

    const entry = authRequests.get(state);
    // Single-use: consume the state immediately so a leaked link cannot be replayed.
    authRequests.delete(state);
    // Reject expired state tokens.
    if (Date.now() - entry.createdAt > STATE_TTL_MS) {
      return res.send(`
        <h1 style="font-size:2.2em;">Verification session expired!</h1>
        <p>To restart the verification process, please initiate it again via Discord.</p>
      `);
    }
    const discordId = entry.discordId;

    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      },
      { headers: { Accept: "application/json" } }
    );

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      return res.send(`
        <h1 style="font-size:2.2em; color:#c0392b;">GitHub OAuth Error</h1>
        <p style="font-size:1.15em;">
          Failed to retrieve access token.<br>
          Please try again, and be sure to grant access to your GitHub profile.
        </p>
        <p style="font-size:1.05em; color:#222;">
          Please return to Discord and initiate the verification process again using the appropriate menu.
        </p>
      `);
    }

    const result = await devverification.processGithubCallback({
      accessToken,
      discordId,
      discordClient,
    });

    if (!result.success) {
      return res.send(`
        <h1 style="font-size:2em; color:#c0392b;">❌ Verification failed!</h1>
        <p>Please fix the following issues:</p>
        <ol>${result.errors.map((e) => `<li>${e}</li>`).join("")}</ol>
      `);
    }

    res.send(`
      <h1 style="font-size:2em; color:green;">✅ Verification successful!</h1>
      <p>You can now close this page.</p>
    `);
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).send(`
      <h1 style="font-size:2.2em; color:#c0392b;">Server error occurred</h1>
      <p>Please try again later or contact support.</p>
    `);
  }
});

if (require.main === module) {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 server.js listening on http://0.0.0.0:${PORT}  (health: /healthz)`);
  });

  server.on("error", (err) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  process.on("unhandledRejection", (r) => {
    console.error("UnhandledRejection:", r);
  });
  process.on("uncaughtException", (e) => {
    console.error("UncaughtException:", e);
    setTimeout(() => process.exit(1), 100);
  });
}

module.exports = { app, discordClient };