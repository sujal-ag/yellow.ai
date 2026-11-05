// Handles one claimed message: rate-limit slot → provider call → fenced result write.

import { config } from '../config.js';
import { pool } from '../db.js';
import * as messages from '../models/message.model.js';
import { sendToProvider } from './sender.js';

// Stop starting new work this long before the lease ends, so a provider call
// (bounded by its timeout) always finishes while we still own the row.
const LEASE_SAFETY_MS = 2000;

/** Exponential backoff with +-20% jitter: base, 2x base, 4x base, ... capped. */
export function backoffMs(attempt) {
  const { backoffBaseMs, backoffMaxMs } = config.worker;
  const raw = Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs);
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}

export function createProcessor({ rateLimiter, stats, onProviderCall }) {
  /**
   * @param {object} msg     row from the claim (attempts already includes this attempt)
   * @param {string} token   claim token (fencing)
   * @param {number} claimedAt  worker clock when the claim committed
   */
  return async function processMessage(msg, token, claimedAt) {
    const deadline = claimedAt + config.worker.leaseMs - config.provider.timeoutMs - LEASE_SAFETY_MS;

    // 1. Rate-limit slot. If Redis is down we fail closed: don't send, hand the
    //    message back without counting the attempt.
    let gotSlot;
    try {
      gotSlot = await rateLimiter.acquire(msg.tenant_id, deadline);
    } catch (err) {
      stats.released++;
      return record(messages.releaseClaim(pool, msg.id, token, 1000, `rate limiter unavailable: ${err.message}`));
    }
    if (!gotSlot) {
      stats.released++;
      return record(messages.releaseClaim(pool, msg.id, token, 0, 'rate-limit wait exceeded lease budget'));
    }

    // 2. Provider call (same Idempotency-Key on every attempt).
    const outcome = await sendToProvider(msg);
    onProviderCall?.(); // crash-injection hook: may SIGKILL us right here

    // 3. Fenced result write.
    switch (outcome.kind) {
      case 'sent':
        stats.sent++;
        if (outcome.detail === 'duplicate') stats.duplicates++;
        return record(messages.markSent(pool, msg.id, token));

      case 'busy':
        // Another request for this key is still being processed by the provider.
        // Not a failure: retry soon without using up an attempt.
        stats.busy++;
        return record(messages.releaseClaim(pool, msg.id, token, 1000, 'provider: key in progress (409)'));

      case 'retry':
        if (msg.attempts >= config.worker.maxAttempts) {
          stats.failed++;
          return record(messages.markFailed(pool, msg.id, token, `gave up after ${msg.attempts} attempts: ${outcome.error}`));
        }
        stats.retried++;
        return record(messages.scheduleRetry(pool, msg.id, token, backoffMs(msg.attempts), outcome.error));

      case 'fatal':
        stats.failed++;
        return record(messages.markFailed(pool, msg.id, token, outcome.error));
    }
  };

  async function record(write) {
    const applied = await write;
    // false = our lease expired and another worker owns the row now. Its result
    // wins; ours is discarded. No harm: the provider dedups by key.
    if (!applied) stats.fenced++;
  }
}
