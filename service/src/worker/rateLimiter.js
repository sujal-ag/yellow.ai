// Per-tenant rate limit shared by ALL workers: Redis sliding-window log.
//
// One sorted set per tenant holds the timestamps of recent sends. A Lua script
// (atomic in Redis) drops entries older than the window, and grants a slot only
// if fewer than N remain. Time comes from Redis's own clock, never a worker's.

import Redis from 'ioredis';
import { config } from '../config.js';
import { pool } from '../db.js';
import { getRateLimit } from '../models/tenant.model.js';

// Returns 0 if a slot was taken, otherwise the ms until the oldest entry leaves
// the window (when a slot may free up).
const ACQUIRE_LUA = `
local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])   -- microseconds
local limit = tonumber(ARGV[1])
local win   = tonumber(ARGV[2])                          -- microseconds

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win)

if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], math.ceil(win / 1000) + 1000)
  return 0
end

local oldest = tonumber(redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2])
return math.max(1, math.ceil((oldest + win - now) / 1000))
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRateLimiter() {
  const redis = new Redis(config.redis.url, {
    // Fail fast instead of queueing commands while disconnected: a worker that
    // can't reach Redis must NOT send (fail closed).
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', (err) => console.error('[rate-limiter] redis error:', err.message));
  redis.defineCommand('rlAcquire', { numberOfKeys: 1, lua: ACQUIRE_LUA });

  const windowUs = config.rateLimit.windowMs * 1000;
  const limits = new Map(); // tenantId -> { n, expiresAt }
  let seq = 0;

  async function limitFor(tenantId) {
    const cached = limits.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.n;
    const n = (await getRateLimit(pool, tenantId)) ?? config.defaultTenantRateLimit;
    limits.set(tenantId, { n, expiresAt: Date.now() + config.rateLimit.tenantLimitCacheMs });
    return n;
  }

  /**
   * Wait for a send slot for this tenant.
   * @param {number} tenantId
   * @param {number} deadlineMs - give up (return false) rather than wait past this time
   * @returns {Promise<boolean>} true = slot taken, send now; false = deadline reached
   * @throws if Redis is unavailable (caller must not send)
   */
  async function acquire(tenantId, deadlineMs) {
    const n = await limitFor(tenantId);
    const member = `${config.worker.id}:${++seq}`;
    for (;;) {
      const waitMs = await redis.rlAcquire(`rl:${tenantId}`, n, windowUs, member);
      if (waitMs === 0) return true;
      if (Date.now() + waitMs > deadlineMs) return false;
      await sleep(waitMs);
    }
  }

  async function close() {
    await redis.quit().catch(() => redis.disconnect());
  }

  return { acquire, close };
}
