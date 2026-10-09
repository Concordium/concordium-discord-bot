"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

const TEST_DISCORD_ID = "123456789012345678";
const TEST_WALLET =
  "3yhsVb1gkDNr1souvty573pqDLk9vybCWpG4bLoHJL7X9wtEEp";

const sentMessages = [];
const sqlQueries = [];

class MockPool {
  async query(sql, params = []) {
    sqlQueries.push({ sql, params });

    if (/FROM\s+verifications/i.test(sql)) {
      assert.equal(params[0], TEST_WALLET);

      return {
        rowCount: 1,
        rows: [
          {
            discord_id: TEST_DISCORD_ID,
            validator_id: "476",
          },
        ],
      };
    }

    if (/FROM\s+notification_prefs/i.test(sql)) {
      return {
        rowCount: 0,
        rows: [],
      };
    }

    throw new Error(`Unexpected SQL query: ${sql}`);
  }
}

Module._load = function (request, parent, isMain) {
  if (request === "pg") {
    return { Pool: MockPool };
  }

  return originalLoad.apply(this, arguments);
};

let alerts;

try {
  alerts = require("../modules/alerts");
} finally {
  Module._load = originalLoad;
}

const mockDiscordClient = {
  users: {
    async send(userId, payload) {
      sentMessages.push({ userId, payload });
      return { id: "mock-message-id" };
    },
  },
};

async function main() {
  alerts.setAlertsClient(mockDiscordClient);

  await alerts.handleValidatorPaydayAccountReward({
    account: TEST_WALLET,
    transactionFees: 189606150,
    bakerReward: 1235985959,
    finalizationReward: 0,
    blockHash:
      "2091576ce2e0692043cab17422f55fb2564933d61e5f62783b7b10aa976b4f0c",
    timestampIso: "2026-10-09T09:00:00.000Z",
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].userId, TEST_DISCORD_ID);

  assert.ok(
    sqlQueries.some(({ sql }) => /FROM\s+verifications/i.test(sql))
  );

  assert.ok(
    sqlQueries.some(({ sql }) => /FROM\s+notification_prefs/i.test(sql))
  );

  console.log("[test] Validator PayDay notification: PASS");
  console.log("[test] PostgreSQL: mocked");
  console.log("[test] Discord: mocked");
  console.log("[test] Messages captured:", sentMessages.length);
}

main().catch((error) => {
  console.error("[test] FAIL:", error);
  process.exitCode = 1;
});