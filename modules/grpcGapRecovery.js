
"use strict";

/**
 * Process a finalized block and backfill any missing heights.
 *
 * Returns the last successfully processed height.
 * Throws if a block cannot be retrieved or processed.
 */
async function processFinalizedBlock({
  grpcClient,
  block,
  lastHeight,
  processBlock,
  debug = false,
}) {
  const h = Number(block.height ?? block.blockHeight);
  const hash = block.hash ?? block.blockHash;

  if (!Number.isSafeInteger(h) || h < 0) {
    throw new Error(`Invalid finalized block height: ${h}`);
  }

  if (
    hash == null ||
    (typeof hash === "string" && hash.trim().length === 0) ||
    ((Buffer.isBuffer(hash) || hash instanceof Uint8Array) &&
      hash.length === 0)
  ) {
    throw new Error(`Invalid finalized block hash at height ${h}`);
  }

  if (lastHeight != null && h <= lastHeight) {
    if (debug) {
      console.log(
        `[grpc] skipping already processed block: ` +
        `height=${h} lastHeight=${lastHeight}`
      );
    }
    return lastHeight;
  }

  if (lastHeight != null && h > lastHeight + 1) {
    const missingFrom = lastHeight + 1;
    const missingTo = h - 1;

    console.warn(
      `[grpc] height gap detected: last=${lastHeight} ` +
      `received=${h} backfill=${missingFrom}..${missingTo}`
    );

    for (let hh = missingFrom; hh <= missingTo; hh++) {
      try {
        const blockHashes = await grpcClient.getBlocksAtHeight(BigInt(hh));

        if (!blockHashes || blockHashes.length === 0) {
          throw new Error(`No block hashes returned at height ${hh}`);
        }

        await processBlock(grpcClient, blockHashes[0], hh);
        lastHeight = hh;
      } catch (e) {
        console.error(
          `[grpc] backfill failed at height ${hh}; ` +
          `last successful height=${lastHeight}:`,
          e?.message || e
        );

        // Preserve the last successful height for the caller.
        e.lastSuccessfulHeight = lastHeight;
        throw e;
      }
    }

    console.log(
      `[grpc] backfill complete: ${missingFrom}..${missingTo} ` +
      `lastHeight=${lastHeight}`
    );
  }

  try {
    await processBlock(grpcClient, hash, h);
  } catch (e) {
    e.lastSuccessfulHeight = lastHeight;
    throw e;
  }

  return h;
}

module.exports = { processFinalizedBlock };
