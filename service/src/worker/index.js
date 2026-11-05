// Worker process entry point. Run as many copies as you like; they coordinate
// only through MySQL (claims + leases) and Redis (rate limit).
//
// Loop: keep up to maxInFlight messages in progress. Whenever there's room,
// claim more due rows; each claimed row is processed independently, so one slow
// provider call never holds up the others.

import { config } from '../config.js';
import { pool } from '../db.js';
import { claimBatch } from './claimer.js';
import { createRateLimiter } from './rateLimiter.js';
import { createProcessor } from './processor.js';

const { id: workerId, batchSize, maxInFlight, pollIntervalMs, crashAfterSends } = config.worker;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[${workerId}]`, ...args);

const stats = {
  claimed: 0, reclaimed: 0, exhausted: 0,
  sent: 0, duplicates: 0, retried: 0, failed: 0, busy: 0, released: 0, fenced: 0,
};

let providerCalls = 0;
function onProviderCall() {
  providerCalls++;
  if (crashAfterSends > 0 && providerCalls >= crashAfterSends) {
    // Simulates kill -9 at the worst moment: the provider has (maybe) sent the
    // message, but we haven't recorded it. The row stays in_progress until its
    // lease expires and another worker takes it over.
    log(`CRASH INJECTION: SIGKILL after ${providerCalls} provider calls`);
    process.kill(process.pid, 'SIGKILL');
  }
}

const rateLimiter = createRateLimiter();
const processMessage = createProcessor({ rateLimiter, stats, onProviderCall });
const inFlight = new Set();
let running = true;

async function loop() {
  log('started', { batchSize, maxInFlight, leaseMs: config.worker.leaseMs, crashAfterSends });
  while (running) {
    const room = maxInFlight - inFlight.size;
    let claimedAny = false;

    if (room > 0) {
      try {
        const batch = await claimBatch(Math.min(batchSize, room));
        stats.claimed += batch.rows.length;
        stats.reclaimed += batch.reclaimed;
        stats.exhausted += batch.exhausted;
        if (batch.reclaimed) log(`reclaimed ${batch.reclaimed} message(s) with expired leases`);

        for (const msg of batch.rows) {
          const task = processMessage(msg, batch.token, batch.claimedAt)
            .catch((err) => log(`message ${msg.id} error (lease will expire and it will be retried):`, err.message))
            .finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
        claimedAny = batch.rows.length > 0;
      } catch (err) {
        // DB unreachable or similar: pause rather than guess (consistency first).
        log('claim failed:', err.message);
        await sleep(1000);
        continue;
      }
    }

    // Claim again right away if we got work and still have room; otherwise wait.
    if (!claimedAny || inFlight.size >= maxInFlight) await sleep(pollIntervalMs);
  }
}

const statsTimer = setInterval(() => log('stats', { inFlight: inFlight.size, ...stats }), 5000);

async function shutdown(signal) {
  if (!running) return;
  running = false;
  log(`${signal}: finishing ${inFlight.size} in-flight message(s)`);
  clearInterval(statsTimer);
  await Promise.allSettled([...inFlight]);
  log('final stats', stats);
  await rateLimiter.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loop().catch((err) => {
  console.error(`[${workerId}] fatal`, err);
  process.exit(1);
});
