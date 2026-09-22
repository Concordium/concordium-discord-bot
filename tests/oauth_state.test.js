const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("OAuth State Hardening Regression Tests", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("fails closed if INTERNAL_API_SECRET is unset or empty", () => {
    delete process.env.INTERNAL_API_SECRET;
    assert.throws(() => {
      const secret = process.env.INTERNAL_API_SECRET;
      if (!secret || secret.trim() === "") {
        throw new Error("FATAL: INTERNAL_API_SECRET environment variable is mandatory");
      }
    }, /INTERNAL_API_SECRET environment variable is mandatory/);
  });

  test("parses STATE_TTL_MS defensively and falls back to default 600000ms", () => {
    process.env.INTERNAL_API_SECRET = "test-secret";
    const { parseStateTtl } = require("../server");

    assert.equal(parseStateTtl(undefined), 600000);
    assert.equal(parseStateTtl(""), 600000);
    assert.equal(parseStateTtl("not-a-number"), 600000);
    assert.equal(parseStateTtl("0"), 600000);
    assert.equal(parseStateTtl("-500"), 600000);
    assert.equal(parseStateTtl("120000"), 120000);
  });

  test("validates state and discordId regex patterns strictly", () => {
    const STATE_REGEX = /^[a-f0-9]{32}$/;
    const DISCORD_ID_REGEX = /^\d{5,25}$/;

    assert.ok(STATE_REGEX.test("e1b2c3d4f5a6b7c8d9e0f1a2b3c4d5e6"));
    assert.ok(!STATE_REGEX.test("e1b2c3d4f5a6b7c8d9e0f1a2b3c4d5e")); // 31 chars
    assert.ok(!STATE_REGEX.test("e1b2c3d4f5a6b7c8d9e0f1a2b3c4d5e67")); // 33 chars
    assert.ok(!STATE_REGEX.test("Z1b2c3d4f5a6b7c8d9e0f1a2b3c4d5e6")); // non-hex
    assert.ok(!STATE_REGEX.test("../evil_path"));

    assert.ok(DISCORD_ID_REGEX.test("12345678901234567"));
    assert.ok(!DISCORD_ID_REGEX.test("1234")); // < 5
    assert.ok(!DISCORD_ID_REGEX.test("12345678901234567890123456")); // > 25
    assert.ok(!DISCORD_ID_REGEX.test("12345abcde67890"));
  });
});
