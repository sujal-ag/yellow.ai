// Central configuration. Every value can be overridden with an env var.

const num = (name, fallback) => Number(process.env[name] ?? fallback);

export const config = {
  api: {
    port: num('API_PORT', 3000),
  },
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: process.env.DB_USER ?? 'app',
    password: process.env.DB_PASSWORD ?? 'app',
    database: process.env.DB_NAME ?? 'dispatcher',
    connectionLimit: num('DB_POOL_SIZE', 10),
  },
  // N used when a campaign arrives for a tenant we haven't seen before.
  defaultTenantRateLimit: num('DEFAULT_TENANT_RATE_LIMIT', 20),

  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  },
  provider: {
    url: process.env.PROVIDER_URL ?? 'http://127.0.0.1:4000',
    // Per-call HTTP timeout. Must be far below the lease.
    timeoutMs: num('PROVIDER_CALL_TIMEOUT_MS', 3000),
  },
  worker: {
    id: process.env.WORKER_ID ?? `worker-${process.pid}`,
    batchSize: num('WORKER_BATCH_SIZE', 20),       // max rows per claim
    maxInFlight: num('WORKER_MAX_IN_FLIGHT', 50),  // max messages being processed at once
    pollIntervalMs: num('WORKER_POLL_INTERVAL_MS', 200),
    leaseMs: num('WORKER_LEASE_MS', 30_000),
    maxAttempts: num('WORKER_MAX_ATTEMPTS', 5),
    backoffBaseMs: num('WORKER_BACKOFF_BASE_MS', 1000), // 1s, 2s, 4s, 8s (+-20% jitter)
    backoffMaxMs: num('WORKER_BACKOFF_MAX_MS', 30_000),
    // Fault injection for the crash test: after this many provider calls, the
    // worker SIGKILLs itself right after a send and BEFORE recording the result.
    // 0 = disabled.
    crashAfterSends: num('WORKER_CRASH_AFTER_SENDS', 0),
  },
  rateLimit: {
    // Sliding window. Wider than 1s on purpose: absorbs network jitter between
    // the worker taking a slot and the provider timestamping the request.
    windowMs: num('RATE_LIMIT_WINDOW_MS', 1100),
    tenantLimitCacheMs: num('RATE_LIMIT_TENANT_CACHE_MS', 30_000),
  },
};
