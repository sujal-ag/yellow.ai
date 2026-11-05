// Mock notification provider (standalone: shares no code or infra with the service).
//
// Stands in for an external provider (Twilio, SendGrid, ...). It delivers nothing;
// it records which Idempotency-Keys it accepted and when. Those records are the
// evidence the end-to-end test checks.
//
// Dedup rule: a key is RESERVED atomically on arrival, before any work is done.
// Node runs one request's JS at a time, so the check + reserve below (no `await`
// between them) cannot interleave with another request for the same key.
//
// Key states:
//   processing  - reserved, work in flight. Has a TTL: if the work doesn't finish
//                 within processingTtlMs, the reservation is stale and the next
//                 request for the key may take it over.
//   accepted    - sent. Permanent: never expires, so a late retry can never send again.
//
// Takeover is fenced: each reservation carries a token, and only the request that
// still holds the current token may mark the key accepted. A slow original request
// that lost its reservation finishes without sending.

import express from 'express';

const config = {
  port: Number(process.env.PROVIDER_PORT ?? 4000),
  errorRate: Number(process.env.PROVIDER_ERROR_RATE ?? 0.2),
  timeoutRate: Number(process.env.PROVIDER_TIMEOUT_RATE ?? 0.1),
  // Simulated work time between reserving a key and accepting it. Non-zero so
  // the "processing" window (and the 409 path) actually exists.
  maxDelayMs: Number(process.env.PROVIDER_MAX_DELAY_MS ?? 50),
  // How long a "timed out" request is held open before the socket is dropped.
  // Must be longer than the worker's HTTP timeout.
  timeoutHoldMs: Number(process.env.PROVIDER_TIMEOUT_HOLD_MS ?? 60_000),
  // How long a 'processing' reservation is honoured before it counts as stale and
  // can be taken over. Should be well above maxDelayMs.
  processingTtlMs: Number(process.env.PROVIDER_PROCESSING_TTL_MS ?? 30_000),
  seed: process.env.PROVIDER_SEED,
};

// Seedable PRNG (mulberry32) so failure injection is reproducible when a seed is
// given. Note: with concurrent requests, which request draws which number depends
// on arrival order, so a seed makes runs similar, not bit-identical.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = config.seed !== undefined ? mulberry32(Number(config.seed)) : Math.random;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// key -> {
//   state: null | 'processing' | 'accepted',
//   reservedAt, token,                                    // current 'processing' reservation
//   accepted: [{ ts, tenant_id, campaign_id, user_id }],  // should only ever hold 1 entry
//   requests, duplicates, conflicts, errors, timeouts,    // per-key counters
//   takeovers, fenced
// }
const keys = new Map();

const COUNTERS = ['requests', 'duplicates', 'conflicts', 'errors', 'timeouts', 'takeovers', 'fenced'];
const totals = { accepted: 0, ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) };

function entryFor(key) {
  let entry = keys.get(key);
  if (!entry) {
    entry = { state: null, reservedAt: 0, token: 0, accepted: [], ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) };
    keys.set(key, entry);
  }
  return entry;
}

function bump(entry, counter) {
  entry[counter]++;
  totals[counter]++;
}

let nextToken = 1;

const app = express();
app.use(express.json());

app.post('/send', async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'Idempotency-Key header is required' });

  const { tenant_id, campaign_id, user_id } = req.body ?? {};

  // ---- synchronous section: check + reserve, no `await` until the reservation is made ----
  const entry = entryFor(key);
  bump(entry, 'requests');

  if (entry.state === 'accepted') {
    bump(entry, 'duplicates');
    return res.status(200).json({ status: 'duplicate' });
  }
  if (entry.state === 'processing') {
    if (Date.now() - entry.reservedAt < config.processingTtlMs) {
      bump(entry, 'conflicts');
      return res.status(409).json({ status: 'in_progress' });
    }
    // Stale reservation: the previous request never finished. Take it over below.
    bump(entry, 'takeovers');
  }

  // One draw split into bands: [0, errorRate) → error,
  // [errorRate, errorRate + timeoutRate) → timeout, rest → clean success.
  const roll = random();

  // Error is decided BEFORE reserving, so a 500 never leaves a stuck reservation
  // and never counts as a send.
  if (roll < config.errorRate) {
    bump(entry, 'errors');
    return res.status(500).json({ error: 'provider_error' });
  }

  const willTimeOut = roll < config.errorRate + config.timeoutRate;
  const delayMs = Math.floor(random() * config.maxDelayMs);

  // Reserve: concurrent requests for this key now get 409 until the TTL passes.
  const myToken = nextToken++;
  entry.state = 'processing';
  entry.reservedAt = Date.now();
  entry.token = myToken;
  // ---- end of synchronous section ----

  await sleep(delayMs); // simulated work

  // Fencing: if our reservation went stale and another request took the key over,
  // we must not send. Report whatever the key's current state is.
  if (entry.token !== myToken) {
    bump(entry, 'fenced');
    return entry.state === 'accepted'
      ? res.status(200).json({ status: 'duplicate' })
      : res.status(409).json({ status: 'in_progress' });
  }

  entry.state = 'accepted'; // permanent: accepted keys never expire
  entry.accepted.push({ ts: Date.now(), tenant_id, campaign_id, user_id });
  totals.accepted++;

  if (willTimeOut) {
    // The message WAS sent, but the caller never hears back.
    bump(entry, 'timeouts');
    setTimeout(() => req.socket.destroy(), config.timeoutHoldMs).unref();
    return;
  }

  return res.status(200).json({ status: 'accepted' });
});

// Every key with its accepted sends (timestamps) and per-key counters.
app.get('/stats', (_req, res) => {
  const byKey = {};
  for (const [key, e] of keys) {
    byKey[key] = {
      accepted: e.accepted,
      ...Object.fromEntries(COUNTERS.map((c) => [c, e[c]])),
    };
  }
  res.json({ totals, keys: byKey });
});

// Test helper: clear all state between runs.
app.post('/reset', (_req, res) => {
  keys.clear();
  for (const k of Object.keys(totals)) totals[k] = 0;
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`[provider] listening on :${config.port}`, {
    errorRate: config.errorRate,
    timeoutRate: config.timeoutRate,
    maxDelayMs: config.maxDelayMs,
    processingTtlMs: config.processingTtlMs,
    seed: config.seed ?? 'random',
  });
});
