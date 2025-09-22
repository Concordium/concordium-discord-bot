// utils/messages.js
/**
 * Centralized message/templating helpers for Discord notifications (Concordium flows).
 * Responsibilities:
 * - Builds CCDScan markdown links for accounts, transactions, and blocks (configurable via CCDSCAN_BASE_URL).
 * - Provides `dmPayload(mention, description)` to create safe DM embed payloads (restricted allowedMentions).
 * - Collects user-facing copy and generators for:
 *   • Validator verification threads & results,
 *   • Delegator verification threads & results,
 *   • PayDay reward notices,
 *   • Pool/commission/delegation change alerts,
 *   • Validator self-stake changes (increase/decrease) and fan-out to delegators.
 * - Includes composable line helpers (accountLine, txLinkLine, blockLine) used in templates.
 */

const { formatPercent } = require("./format");
const CCDSCAN_BASE_URL = process.env.CCDSCAN_BASE_URL || "https://ccdscan.io";

// ——— helpers ———
function scanAccountLink(address, label = address) {
  if (!address) return null;
  const url = `${CCDSCAN_BASE_URL}/?dcount=1&dentity=account&daddress=${encodeURIComponent(address)}`;
  return `[${label}](${url})`;
}
function scanTxLink(txHash, label = txHash) {
  if (!txHash) return null;
  const url = `${CCDSCAN_BASE_URL}/?dcount=1&dentity=transaction&dhash=${encodeURIComponent(txHash)}`;
  return `[${label}](${url})`;
}
function scanBlockLink(blockHash, label = blockHash) {
  if (!blockHash) return null;
  const url = `${CCDSCAN_BASE_URL}/?dcount=1&dentity=block&dhash=${encodeURIComponent(blockHash)}`;
  return `[${label}](${url})`;
}
function scanValidatorLink(validatorId, label = `#${validatorId}`) {
  if (validatorId == null) return null;
  const url = `${CCDSCAN_BASE_URL}/?dcount=1&dentity=validator&did=${encodeURIComponent(validatorId)}`;
  return `[${label}](${url})`;
}

const accountLine = (label, address) => (address ? `${label}: ${scanAccountLink(address)}` : "");
const txLinkLine  = (txHash) => (txHash ? `\nTx: ${scanTxLink(txHash)}` : "");
const blockLine   = (blockHash) => (blockHash ? `\nBlock: ${scanBlockLink(blockHash)}` : "");

function dmPayload(mention, description) {
  const payload = {
    content: mention || "",
    embeds: [{ description }]
  };
  if (typeof mention === "string") {
    const m = mention.match(/^<@!?(\d+)>$/);
    payload.allowedMentions = m ? { users: [m[1]], parse: [] } : { parse: [] };
  }
  return payload;
}

const MSGS = {
  // ===== validator-verification =====
  alreadyHasRole: "✅ You already have the **Validator** role — no need to verify again.",
  threadExists: (guildId, threadId) =>
    `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${guildId}/${threadId})`,
  verificationStarted: (guildId, threadId) =>
    `📩 The validator verification process has started.\n👉 [Click here to open your thread](https://discord.com/channels/${guildId}/${threadId})`,
  introThread: (userId) =>
    `<@${userId}> Please send your **validator ID** to begin verification (e.g. 12345). This thread is completely private - no one except you and the Concordium team has access to it. \n\n` +
    `**Important notes:**\n` +
    `- If you leave this thread inactive for 1 hour, it will be automatically deleted\n` +
    `- If you entered the wrong ID, you can use the command \`/start-again-validator\` to restart`,
  verificationInactive: (claimChannelId) =>
    `⚠️ The verification process for this thread is no longer active due to bot restarting. Please start the verification process again in the <#${claimChannelId}> channel`,
  invalidValidatorId: "❌ Please enter a valid numeric validator ID.",
  grpcUnavailable: "⚠️ The verification service is temporarily unavailable (connection to Concordium node failed).\nPlease try again later.",
  validatorIdNotFound:
    "❌ Failed to retrieve validator address. Please double-check the ID. Aren't you suspended?\nIf you registered as a validator today less than an hour before PayDay, you will only be able to verify tomorrow after the new PayDay.",
  errorCheckingValidatorId: "❌ An unexpected error occurred while checking your validator ID. Please try again or contact support.",
  validatorAlreadyInVerification: "❌ This validator is already being verified by another user.",
  validatorAlreadyRegistered: "❌ This validator address is already registered. Please check the ID or contact a moderator.",
  addressConfirmed: (validatorAddress, randomMemo) =>
    `✅ Your validator address is: \`${validatorAddress}\`\n\n` +
    `Now send a CCD transaction **from this address to any address**, using this generated number as the MEMO: \`${randomMemo}\`\n\n` +
    `**Transaction requirements:**\n` +
    `- Any CCD amount (e.g. 0.000001)\n` +
    `- Must be sent within 1 hour\n` +
    `- MEMO must exactly match: \`${randomMemo}\`\n`,
  invalidTxHash: "❌ Please enter a valid 64-character transaction hash.",
  txNotFinalized: "❌ Transaction is not finalized or was not successful.",
  txWrongSender: (validatorAddress) => `❌ Sender address must match the validator address: \`${validatorAddress}\``,
  txWrongMemo: (randomMemo) => `❌ The MEMO must exactly match the generated number: \`${randomMemo}\``,
  failedToExtractBlockHash: "❌ Unable to extract block hash to validate transaction time.",
  failedToGetBlockTimestamp: "❌ Failed to retrieve block timestamp.",
  txExpired: "❌ This transaction is older than 1 hour. Please submit a fresh one.",
  txAlreadyUsed: "❌ This transaction has already been used for verification.",
  verificationSuccess: (roleId, channelId) =>
    `🎉 You have been successfully verified as a <@&${roleId}> and your role has been assigned!\n` +
    `From now on I'll DM you when:\n` +
    `• Your validator is **pending for suspension**, **suspended** or **active again**;\n` +
    `• A new validator is registered on the network or an existing one is deleted;\n` +
    `• A new delegator joins your pool or existing delegator leaves your pool;\n` +
    `• A delegator in your pool or you as a Validator **increases or decreases stake**;\n` +
    `• You receive **PayDay rewards** for validation.\n\n` +
    `You now have access to the private Validators channel: <#${channelId}>\n` +
    `To mute or resume these DMs at any time, use \`/receive-notifications\` on/off on any channel.\n\n` +
    `You can now delete this thread.`,
  modLogsValidatorAssigned: (roleId, userId) =>
    `✅ Assigned <@&${roleId}> to <@${userId}> after successful validator on-chain verification.`,
  failedToArchiveThread: "❌ Failed to archive thread. Please try again later.",
  noActiveValidatorThread: (channelId) =>
    `⚠️ You don't have an active validator verification thread. Please start the verification using the dropdown menu on the <#${channelId}>.`,
  previousDelegatorThreadNotFound: (channelId) =>
    `⚠️ Your previous validator verification thread could not be found. Please start again from the dropdown menu on the <#${channelId}>.`,
  verificationRestarted: (userId) =>
    `<@${userId}> 🔁 Verification has been restarted.\n` +
    `Please send your **validator ID** again (e.g. \`12345\`).\n\n` +
    `**Remember:**\n` +
    `- You have 1 hour to complete each step\n` +
    `- Inactive threads will be deleted after 1 hour\n` +
    `- Use \`/start-again-validator\` if you need to restart again`,
  flowRestarted: "🔄 Verification process restarted in your existing thread.",
  failedToStartValidatorVerification: "❌ Failed to start validator verification. Please contact a moderator.",

  // ===== delegator-verification =====
  alreadyHasDelegatorRole: "✅ You already have the **Delegator** role — no need to verify again.",
  delegatorThreadExists: (guildId, threadId) =>
    `⚠️ You already have an active verification thread.\n👉 [Open thread](https://discord.com/channels/${guildId}/${threadId})`,
  delegatorVerificationStarted: (guildId, threadId) =>
    `📩 The delegator verification process has started.\n👉 [Click here to open your thread](https://discord.com/channels/${guildId}/${threadId})`,
  delegatorIntroThread: (userId) =>
    `<@${userId}> Please send your **account address** to begin verification. This thread is completely private - no one except you and the Concordium team has access to it. \n\n` +
    `**Requirements:**\n` +
    `- You must be delegating at least **1000 CCD** to any pool or using passive delegation.\n` +
    `If you entered the wrong address, use \`/start-again-delegator\` to restart.\n` +
    `If you leave this thread inactive for more than **1 hour**, it will be automatically removed.`,
  delegatorAddressInVerification: "❌ This delegator address is already being verified by another user.",
  invalidDelegatorAddress: "❌ Please enter a valid Concordium account address.",
  delegatorAlreadyRegistered: "❌ This address is already registered as a Delegator. Please check the address or contact a moderator.",
  notDelegating: "❌ This address is not currently delegating to any staking pool or using passive delegation.",
  insufficientStake: (amount) =>
    `❌ Your staked amount is **${amount} CCD**, which is below the required **1000 CCD**.\n` +
    `Please increase your delegation and try again.`,
  unknownDelegationTarget: "❌ Could not determine your delegation status. You must be delegating to either a specific pool or using passive delegation.",
  delegatorAccountConfirmed: (randomMemo, delegationTarget) =>
    `✅ Account verified! Now send a CCD transaction **from this address** with these requirements:\n\n` +
    `**1.** Send to any address\n` +
    `**2.** Any amount (e.g. 0.000001)\n` +
    `**3.** Use this exact number as MEMO: \`${randomMemo}\`\n` +
    `**4.** The transaction age must not exceed **1 hour** from the start of verification.\n\n` +
    `ℹ️ You are using ${delegationTarget === 'passive' ? 'passive delegation' : `pool delegation (pool ID: ${delegationTarget})`}.`,
  DelegationtxWrongSender: (address) => `❌ Sender address must match your delegator address: \`${address}\``,
  DelegationtxWrongMemo: (memo) => `❌ The MEMO must exactly match the generated number: \`${memo}\``,
  delegatorVerificationSuccess: (roleId) =>
    `🎉 You have been successfully verified as a <@&${roleId}> and your role has been assigned!\n` +
    `From now on I'll DM you when:\n` +
    `• Your validator's status changes: **suspension is pending**, **suspended**, or **active again**;\n` +
    `• Your validator **updates commission rates**;\n` +
    `• A new validator is registered on the network or an existing one is deleted;\n` +
    `• **You or the owner of the pool to which you delegating** increasing or decreasing its stake (cooldown info included when applicable);\n` +
    `• Your delegation target **changes** or becomes **passive** (e.g., validator removed);\n` +
    `• You receive **PayDay rewards** for delegation.\n\n` +
    `To mute or resume these DMs at any time, use \`/receive-notifications\` on/off in any channel.\n\n` +
    `You can now delete this thread.`,
  passiveDelegatorVerificationSuccess: (roleId) =>
    `🎉 You have been successfully verified as a <@&${roleId}> and your role has been assigned!\n\nYou can now delete this thread.`,
  modLogsDelegatorAssigned: (roleId, userId) =>
    `✅ Assigned <@&${roleId}> to <@${userId}> after successful delegator on-chain verification.`,
  noActiveDelegatorThread: (channelId) =>
    `⚠️ You don't have an active delegator verification thread. Please start the verification using the dropdown menu on the <#${channelId}>.`,
  previousDelegatorThreadNotFound: (channelId) =>
    `⚠️ Your previous delegator verification thread could not be found. Please start again from the dropdown menu on the <#${channelId}>.`,
  delegatorVerificationRestarted: (userId) =>
    `<@${userId}> 🔁 Verification has been restarted.\n\n` +
    `Please send your **account address** again.\n` +
    `**Remember:**\n` +
    `- You must be delegating at least **1000 CCD**\n` +
    `- You have 1 hour to complete each step\n` +
    `- Inactive threads will be deleted after 1 hour\n\n` +
    `If you entered the wrong address again, use \`/start-again-delegator\` to restart.`,
  delegatorFlowRestarted: "🔄 Verification process restarted in your existing thread.",
  failedToStartDelegatorVerification: "❌ Failed to start delegator verification. Please contact a moderator.",

  // ===== PayDay =====
  blockLine: (blockHash) => (blockHash ? `\nBlock: ${scanBlockLink(blockHash)}` : ""),

  validatorPaydayReward: (mention, totalCCD, bakerCCD, feesCCD, blockHash) => {
    const body =
      `💰 **PayDay reward!**\n` +
      `You received **${totalCCD} CCD** to your validator account.\n` +
      `Breakdown: baking **${bakerCCD}**, tx fees **${feesCCD}**.` +
      blockLine(blockHash);
    return dmPayload(mention, body);
  },

  delegatorPaydayReward: (mention, amountCcd, blockHash, delegationTarget) => {
    const poolLine =
      delegationTarget === "passive"
        ? `\nDelegation target: **Passive pool**`
        : (delegationTarget ? `\nDelegation target: **Pool #${delegationTarget}**` : "");
    const body =
      `💰 **PayDay reward received!**\n` +
      `Your account has been credited with **${amountCcd} CCD**.` +
      poolLine +
      blockLine(blockHash);

    return dmPayload(mention, body);
  },

  // ===== alerts =====

  delegatorRoleRevokedBelowMinimum: (mention, wallet, minCcd, currentCcd, txHash, blockHash) => {
    // Build a clear notice with links and context
    const body =
      `⚠️ **Delegator role removed**\n` +
      `We detected that your delegation decreased below the required minimum of **${Number(minCcd).toLocaleString("en-US")} CCD** for the Delegator role.\n` +
      `${accountLine("Wallet", wallet)}\n` +
      (Number.isFinite(Number(currentCcd)) ? `Current delegated stake: **${Number(currentCcd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CCD**.` : "") +
      txLinkLine(txHash) + 
      blockLine(blockHash) +
      `\n\nTo regain the role, increase your delegation back to **${Number(minCcd).toLocaleString("en-US")} CCD** or more and re-verify.`;

    return dmPayload(mention, body);
  },  
  
  // New delegator joined a pool (validator owners fan-out)
  newDelegatorJoined: (mention, poolId, delegatorAccount, stakeCCD, txHash) => {
    const body =
      `🆕 **New delegator joined your pool #${poolId}**\n` +
      `${accountLine("Wallet", delegatorAccount)}\n` +
      `Initial stake: **${stakeCCD} CCD**.` +
      txLinkLine(txHash);
    return dmPayload(mention, body);
  },

  // ===== network-wide validator appearance/removal =====
  networkNewValidator: (
    mention,
    validatorId,
    account,
    stakeCCD,
    openStatus,
    commissions,
    txHash,
    blockHash,
    metadataUrl
  ) => {
    const niceOpen = (() => {
      if (!openStatus) return null;
      const map = {
        openForAll: "open for all",
        closedForNew: "closed for new delegations",
        closedForAll: "closed for all",
        openForExisting: "open for existing delegators"
      };
      return map[openStatus] || String(openStatus);
    })();

    const commParts = [];
    if (typeof commissions?.baking === "number") {
      commParts.push(`baking **${formatPercent(commissions.baking)}**`);
    }
    if (typeof commissions?.txFee === "number") {
      commParts.push(`tx fees **${formatPercent(commissions.txFee)}**`);
    }
    const commLine = commParts.length ? `\nCommissions: ${commParts.join(", ")}.` : "";

    const metaLine = metadataUrl && metadataUrl.trim()
      ? `\nMetadata: ${metadataUrl.trim()}`
      : "";

    const body =
      `🆕 **New validator joined the network!**\n` +
      `Validator: **${scanValidatorLink(validatorId)}**\n` +
      `${accountLine("Wallet", account)}\n` +
      `Initial self-stake: **${stakeCCD} CCD**.` +
      (niceOpen ? `\nOpen status: **${niceOpen}**.` : "") +
      commLine +
      metaLine +
      txLinkLine(txHash) + blockLine(blockHash);

    return dmPayload(mention, body);
  },

  networkValidatorRemoved: (mention, validatorId, account, txHash, blockHash) => {
    const body =
      `🗑️ **A different validator was removed from the network.**\n` +
      `Validator: **${scanValidatorLink(validatorId)}**\n` +
      `${accountLine("Wallet", account)}` +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  }, 
  
  // Own delegation stake changed
  delegatorStakeIncreased: (mention, newStakeCCD, txHash, blockHash) => {
    const body =
      `🔼 **Stake increased!**\n` +
      `Your new delegation stake is **${newStakeCCD} CCD**.` +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  },

  delegatorStakeDecreased: (mention, newStakeCCD, cooldownAmountCCD, cooldownWhen, txHash, blockHash) => {
    const cd = (cooldownAmountCCD && cooldownWhen)
      ? `\n⏳ Inactive stake in cooldown: **${cooldownAmountCCD} CCD**, available after **${cooldownWhen}**.`
      : "";
    const body =
      `🔽 **Stake decreased!**\n` +
      `Your new delegation stake is **${newStakeCCD} CCD**.` +
      cd +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  },

  // Validator self-stake changes (to validator owners)
  validatorSelfStakeIncreased: (mention, newStakeCCD, _account, _timestampIso, txHash, blockHash) => {
    const body =
      `🔼 **You increased your stake!**\n` +
      `New stake: **${newStakeCCD} CCD**.` +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  },
  
validatorSelfStakeDecreased: (mention, newStakeCCD, cooldowns, txHash, blockHash, timestampIso) => {
  const timeLine = timestampIso ? `\nTime: ${timestampIso}` : "";
  let cd = "";
  if (Array.isArray(cooldowns) && cooldowns.length) {
    cd = "\n⏳ Inactive stake in cooldown:\n" +
         cooldowns.map(c => `• **${c.amountCCD} CCD** — available after **${c.when}**.`).join("\n");
  }
  const body =
    `🔽 **You decreased your stake!**\n` +
    `New stake: **${newStakeCCD} CCD**.` +
    timeLine +
    cd +
    txLinkLine(txHash) + blockLine(blockHash);
  return dmPayload(mention, body);
},

  // Fan-out to delegators of a validator who changed self-stake
  delegatorValidatorSelfStakeIncreased: (mention, validatorId, newStakeCCD, _timestampIso, txHash, blockHash) => {
    const body =
      `🔼 **The validator you delegate to (#${validatorId}) increased their stake!**\n` +
      `New stake: **${newStakeCCD} CCD**.` +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  },
  delegatorValidatorSelfStakeDecreased: (mention, validatorId, newStakeCCD, txHash, blockHash) => {
    const body =
      `🔽 **The validator you delegate to (#${validatorId}) decreased their stake!**\n` +
      `New stake: **${newStakeCCD} CCD**.` +
      txLinkLine(txHash) + blockLine(blockHash);
    return dmPayload(mention, body);
  },

  // Validator lifecycle + pool/target/commission changes
  validatorReactivated: (mention, wallet) => {
    const body =
      `🎉 Great news! Your validator (Address: \`${wallet}\`) is now *active* again.\n` +
      `You are once again eligible to receive staking rewards.`;
    return dmPayload(mention, body);
  },
  validatorSuspended: (mention, wallet) => {
    const body =
      `🚨 Attention! Your validator (Address: \`${wallet}\`) is currently **suspended**.\n` +
      `You will not receive rewards while your validator remains in this status.\n` +
      `Learn how to unsuspend validator by referring to ` +
      `[this article](https://docs.concordium.com/en/mainnet/docs/network/guides/suspend-unsuspend-validator.html)`;
    return dmPayload(mention, body);
  },
  validatorPendingSuspension: (mention, wallet_address) => {
    const body =
      `⚠️ Attention! Your validator (Address: \`${wallet_address}\`) is **nominated for suspension** (suspension is pending).\n` +
      `If you don't fix the issue before the next PayDay, your validator will be suspended and you will stop receiving validation rewards.`;
    return dmPayload(mention, body);
  },

  commissionChanged: (mention, poolId, oldBaking, bakingRate, oldTx, transactionFeeRate) => {
    const body =
      `📢 **Commission update alert!**\n\n` +
      `The validator to whom you're delegating (ID: \`#${poolId}\`) has recently updated their commission rates.\n\n` +
      `- **Baking commission**: ${formatPercent(oldBaking)} → ${formatPercent(bakingRate)}\n` +
      `- **Transaction commission**: ${formatPercent(oldTx)} → ${formatPercent(transactionFeeRate)}\n\n` +
      `Please review these changes to make informed decisions about your delegation strategy.`;
    return dmPayload(mention, body);
  },

  delegationBecamePassive: (mention, wallet) => {
    const body =
      `⚠️ **Your delegation is now passive!**\n\n` +
      `Your wallet \`${wallet}\` is no longer delegating to any validator pool and has switched to **passive delegation**.\n\n` +
      `This happens when the validator you delegating to is removed.\n\n` +
      `⛔ Passive delegation has a high default commissions of **25%**.\n` +
      `✅ Consider switching to an active validator for better rewards.`;
    return dmPayload(mention, body);
  },

  delegationTargetChanged: (mention, wallet, target) => {
    const body =
      `🔄 **Your delegation target has changed!**\n\n` +
      `Your wallet \`${wallet}\` is now delegating to a new validator pool with ID: \`${target}\`.`;
    return dmPayload(mention, body);
  },

  delegatorValidatorSuspended: (mention, validatorId) => {
    const body =
      `🚨 Attention! Validator \`#${validatorId}\` you're delegating to is now **suspended**.\n` +
      `You will NOT receive staking rewards until it's active again.\n` +
      `Please contact your validator or select a different delegation target.`;
    return dmPayload(mention, body);
  },
  delegatorValidatorActive: (mention, validatorId) => {
    const body =
      `🎉 Good news! Validator \`#${validatorId}\` you're delegating to is now **active** again.\n` +
      `You will resume earning staking rewards.`;
    return dmPayload(mention, body);
  },
  delegatorValidatorPendingSuspension: (mention, validatorId) => {
    const body =
      `⚠️ Warning! Validator \`#${validatorId}\` you're delegating to is **nominated for suspension** (suspension is pending).\n` +
      `If the issue is not resolved before the next PayDay, it will be suspended and you will stop receiving delegation rewards.\n` +
      `Please contact your validator or select a different delegation target.`;
    return dmPayload(mention, body);
  },

  delegatorLeftPool: (mention, poolId, delegatorAccount, delegatorId, timestampIso, txHash) => {
    const timeLine = timestampIso ? `\nTime: ${timestampIso}` : "";
    const txLine   = txLinkLine(txHash);
    const body =
      `👋 **A delegator left your pool #${poolId}**\n` +
      `${accountLine("Wallet", delegatorAccount)} (delegator ID ${delegatorId})` +
      timeLine + txLine;
    return dmPayload(mention, body);
  },

  delegatorJoinedPool: (mention, poolId, delegatorAccount, delegatorId, timestampIso, txHash, stakeCCD) => {
    const timeLine  = timestampIso ? `\nTime: ${timestampIso}` : "";
    const txLine    = txLinkLine(txHash);
    const stakeLine = Number.isFinite(Number(stakeCCD))
      ? `\nStake: **${Number(stakeCCD).toLocaleString("en-US", { maximumFractionDigits: 6 })} CCD**.`
      : "";

    const body =
      `✅ **An existing delegator has switched to your pool #${poolId}**\n` +
      `${accountLine("Wallet", delegatorAccount)} (delegator ID ${delegatorId})` +
      stakeLine + timeLine + txLine;

    return {
      content: mention,
      embeds: [{ description: body }],
    };
  },

  delegatorStakeChangedForValidator: (
    mention,
    poolId,
    delegatorAccount,
    delegatorId,
    direction,
    stakeCCD,
    timestampIso,
    txHash
  ) => {
    const arrow   = direction === "increased" ? "⬆️" : "⬇️";
    const timeLn  = timestampIso ? `\nTime: ${timestampIso}` : "";
    const txLn    = txLinkLine(txHash);
    const stakeLn = Number.isFinite(Number(stakeCCD))
      ? Number(stakeCCD).toLocaleString("en-US", { maximumFractionDigits: 6 })
      : "unknown";

    const body =
      `${arrow} **A delegator ${direction} stake in your pool #${poolId}**\n` +
      `${accountLine("Wallet", delegatorAccount)} (delegator ID ${delegatorId})\n` +
      `New stake: **${stakeLn} CCD.**` +
      timeLn + txLn;

    return dmPayload(mention, body);
  },
};

module.exports = {
  MSGS,
  scanAccountLink,
  scanTxLink,
  scanBlockLink,
  scanValidatorLink,
  accountLine,
  txLine: txLinkLine,
};