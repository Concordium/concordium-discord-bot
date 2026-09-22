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

// Fail-closed enforcement: INTERNAL_API_SECRET is mandatory for secure operations.
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
if (!INTERNAL_API_SECRET || INTERNAL_API_SECRET.trim() === "") {
  throw new Error("FATAL: INTERNAL_API_SECRET environment variable is mandatory and must be configured.");
}

// Defensively parse STATE_TTL_MS falling back to default (10 minutes) if missing, non-numeric, zero, or negative.
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
function parseStateTtl(raw) {
  const parsed = parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_STATE_TTL_MS;
}
const STATE_TTL_MS = parseStateTtl(process.env.STATE_TTL_MS);

const authRequests = new Map();

const STATE_REGEX = /^[a-f0-9]{32}$/;
const DISCORD_ID_REGEX = /^\d{5,25}$/;

function pruneExpiredStates(now = Date.now()) {
  for (const [state, entry] of authRequests) {
    if (now - entry.createdAt > STATE_TTL_MS) authRequests.delete(state);
  }
}
setInterval(() => pruneExpiredStates(), STATE_TTL_MS).unref?.();

// Only initialize the Discord client when a token is provided (avoids crashing in headless unit tests).
let discordClient = null;

if (require.main === module && DISCORD_BOT_TOKEN) {
  discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  discordClient
    .login(DISCORD_BOT_TOKEN)
    .then(() => console.log("✅ server.js Discord client logged in"))
    .catch((e) => console.error("❌ server.js Discord login failed:", e));
}

app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/save-state", (req, res) => {
  try {
    const provided = req.get("x-internal-secret");
    if (!provided || provided !== INTERNAL_API_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { state, discordId } = req.body || {};
    if (
      typeof state !== "string" ||
      !STATE_REGEX.test(state) ||
      typeof discordId !== "string" ||
      !DISCORD_ID_REGEX.test(discordId)
    ) {
      return res.status(400).json({ success: false, error: "Invalid request" });
    }

    pruneExpiredStates();

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
  if (!state || typeof state !== "string" || !STATE_REGEX.test(state)) {
    return res.status(400).send("Error: 'state' is missing or malformed.");
  }

  pruneExpiredStates();
  if (!authRequests.has(state)) {
    return res.status(400).send("Error: 'state' is invalid, unregistered, or has expired.");
  }

  const authUrl =
    `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=read:user,public_repo&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Invalidate state immediately if user returned with an error (e.g. access_denied)
    if (error) {
      if (typeof state === "string" && STATE_REGEX.test(state)) {
        authRequests.delete(state);
      }
      return res.status(400).send(`
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

    if (
      !state ||
      typeof state !== "string" ||
      !STATE_REGEX.test(state) ||
      !code ||
      typeof code !== "string"
    ) {
      if (typeof state === "string") authRequests.delete(state);
      return res.status(400).send(`
        <h1 style="font-size:2.2em; color:#c0392b;">Invalid Request</h1>
        <p>Missing or malformed OAuth authorization parameters.</p>
      `);
    }

    if (!authRequests.has(state)) {
      return res.status(400).send(`
        <h1 style="font-size:2.2em;">Verification session expired!</h1>
        <p>To restart the verification process, please initiate it again via Discord.</p>
      `);
    }

    const entry = authRequests.get(state);
    // Single-use: consume the state immediately
    authRequests.delete(state);

    if (Date.now() - entry.createdAt > STATE_TTL_MS) {
      return res.status(400).send(`
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
      return res.status(400).send(`
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
      return res.status(400).send(`
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

module.exports = { app, discordClient, authRequests, parseStateTtl };
