
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  processFinalizedBlock,
} = require("../modules/grpcGapRecovery");

function createMock(overrides = {}) {
  const processed = [];

  const grpcClient = {
    async getBlocksAtHeight(height) {
      return [`hash-${height}`];
    },
    ...overrides,
  };

  async function processBlock(client, hash, height) {
    processed.push({ hash, height });
  }

  return { grpcClient, processBlock, processed };
}

test("processes consecutive blocks", async () => {
  const mock = createMock();
  let lastHeight = null;

  for (const height of [100, 101, 102]) {
    lastHeight = await processFinalizedBlock({
      ...mock,
      block: { height, hash: `hash-${height}` },
      lastHeight,
    });
  }

  assert.equal(lastHeight, 102);
  assert.deepEqual(
    mock.processed.map((b) => b.height),
    [100, 101, 102]
  );
});

test("backfills missing heights in order", async () => {
  const mock = createMock();

  const lastHeight = await processFinalizedBlock({
    ...mock,
    block: { height: 104, hash: "hash-104" },
    lastHeight: 100,
  });

  assert.equal(lastHeight, 104);
  assert.deepEqual(
    mock.processed.map((b) => b.height),
    [101, 102, 103, 104]
  );
});

test("preserves last successful height on backfill failure", async () => {
  const mock = createMock({
    async getBlocksAtHeight(height) {
      if (height === 102n) {
        throw new Error("Simulated gRPC failure");
      }
      return [`hash-${height}`];
    },
  });

  await assert.rejects(
    processFinalizedBlock({
      ...mock,
      block: { height: 104, hash: "hash-104" },
      lastHeight: 100,
    }),
    (error) => {
      assert.match(error.message, /Simulated gRPC failure/);
      assert.equal(error.lastSuccessfulHeight, 101);
      return true;
    }
  );

  assert.deepEqual(
    mock.processed.map((b) => b.height),
    [101]
  );
});

test("rejects empty block hashes", async () => {
  const mock = createMock({
    async getBlocksAtHeight() {
      return [];
    },
  });

  await assert.rejects(
    processFinalizedBlock({
      ...mock,
      block: { height: 103, hash: "hash-103" },
      lastHeight: 100,
    }),
    (error) => {
      assert.match(error.message, /No block hashes returned/);
      assert.equal(error.lastSuccessfulHeight, 100);
      return true;
    }
  );
});

test("skips already processed blocks", async () => {
  const mock = createMock();

  const lastHeight = await processFinalizedBlock({
    ...mock,
    block: { height: 100, hash: "hash-100" },
    lastHeight: 100,
  });

  assert.equal(lastHeight, 100);
  assert.equal(mock.processed.length, 0);
});

test("rejects invalid block heights", async () => {
  const mock = createMock();

  await assert.rejects(
    processFinalizedBlock({
      ...mock,
      block: { height: "invalid", hash: "hash-invalid" },
      lastHeight: 100,
    }),
    /Invalid finalized block height/
  );
});

test("resumes from the failed height after reconnect", async () => {
  let failOnce = true;
  const mock = createMock({
    async getBlocksAtHeight(height) {
      if (height === 102n && failOnce) {
        failOnce = false;
        throw new Error("Temporary gRPC failure");
      }
      return [`hash-${height}`];
    },
  });

  let lastHeight = 100;

  try {
    lastHeight = await processFinalizedBlock({
      ...mock,
      block: { height: 104, hash: "hash-104" },
      lastHeight,
    });
    assert.fail("Expected a temporary gRPC failure");
  } catch (error) {
    assert.match(error.message, /Temporary gRPC failure/);
    lastHeight = error.lastSuccessfulHeight;
  }

  assert.equal(lastHeight, 101);

  // Simulate the listener reconnecting from lastHeight + 1.
  const reconnectFrom = lastHeight + 1;
  assert.equal(reconnectFrom, 102);

  for (const height of [102, 103, 104]) {
    lastHeight = await processFinalizedBlock({
      ...mock,
      block: { height, hash: `hash-${height}` },
      lastHeight,
    });
  }

  assert.equal(lastHeight, 104);
  assert.deepEqual(
    mock.processed.map((b) => b.height),
    [101, 102, 103, 104]
  );
});

test("preserves height when processBlock fails", async () => {
  const processed = [];

  const grpcClient = {
    async getBlocksAtHeight(height) {
      return [`hash-${height}`];
    },
  };

  async function processBlock(client, hash, height) {
    if (height === 102) {
      throw new Error("Block processing failed");
    }

    processed.push(height);
  }

  await assert.rejects(
    processFinalizedBlock({
      grpcClient,
      processBlock,
      block: { height: 104, hash: "hash-104" },
      lastHeight: 100,
    }),
    (error) => {
      assert.match(error.message, /Block processing failed/);
      assert.equal(error.lastSuccessfulHeight, 101);
      return true;
    }
  );

  assert.deepEqual(processed, [101]);
});

test("rejects finalized blocks without a hash", async () => {
  const mock = createMock();

  await assert.rejects(
    processFinalizedBlock({
      ...mock,
      block: { height: 101 },
      lastHeight: 100,
    }),
    /Invalid finalized block hash at height 101/
  );

  assert.equal(mock.processed.length, 0);
});
