# Scheduled Notification Dispatcher

A service that sends scheduled campaign notifications (SMS / WhatsApp / email) through a provider, with multiple worker processes sharing one database.

**Stack:** Node.js + Express · MySQL 8 · Redis 7 · Docker Compose

> **Status:** the API (create + status), the workers, retries with backoff, crash recovery, the shared rate limiter and the mock provider are implemented. **Cancel** (`POST /campaigns/:id/cancel`) and an **automated end-to-end test** are not built yet (see [Not yet covered](#not-yet-covered)).

---

## Components

```
                 ┌──────────────┐
  POST /campaigns│   API (1x)   │ GET /campaigns/:id
  ──────────────►│   Express    │◄──────────────
                 └──────┬───────┘
                        │ writes campaign + message rows
                        ▼
                 ┌──────────────┐        ┌──────────────┐
                 │   MySQL 8    │        │   Redis 7    │
                 │ messages =   │        │ per-tenant   │
                 │ shared queue │        │ rate limiter │
                 └──▲───────▲───┘        └──▲───────▲───┘
                    │ claim │ record        │ slot  │
              ┌─────┴──┐ ┌──┴─────┐         │       │
              │Worker A│ │Worker B│─────────┴───────┘
              └────┬───┘ └───┬────┘
                   │ POST /send (Idempotency-Key)
                   ▼         ▼
                 ┌──────────────┐
                 │Mock provider │  GET /stats
                 └──────────────┘
```

- **API:** seeds campaigns and reports counts. Never sends anything.
- **Workers (2+):** identical processes. Each pulls due messages from MySQL, takes a rate-limit slot from Redis, and calls the provider.
- **MySQL:** the single source of truth. The `messages` table *is* the queue; there are no per-worker queues.
- **Redis:** holds only rate-limit state (short-lived and safe to lose).
- **Mock provider:** accepts each Idempotency-Key once and records the timestamp of every accepted send.

---

## Core idea: exactly-once = at-least-once + idempotency

Exactly-once delivery to an external system is impossible on its own: a worker can crash, or a call can fail, *after* the provider has acted. So the guarantee has two layers:

| Layer | Mechanism | Purpose |
|---|---|---|
| Database claim | `SELECT … FOR UPDATE SKIP LOCKED` + lease + claim token | **Efficiency:** two workers don't work on the same message at the same time |
| Provider dedup | `Idempotency-Key: {campaign_id}:{user_id}`, fixed for the message's whole lifetime | **Correctness:** even if a message is attempted twice, the provider accepts it once |

> We may *attempt* a message more than once; the provider *accepts* it exactly once.

The key is derived from the message's identity, never generated per attempt, so every retry and every takeover by another worker sends the same key.

---

## How each rule is met

### 1. Exactly one send across multiple workers

**Message lifecycle columns:**

| Column | Meaning |
|---|---|
| `status` | `pending` · `in_progress` · `sent` · `failed` · `cancelled` |
| `lease_until` | the owner promises to finish by this time |
| `claim_token` | random id of the claim that currently owns the row |
| `attempts` | number of claims so far |
| `next_attempt_at` | earliest time the message may be claimed again |

**Worker loop** (every worker runs the same loop):

```
loop:
  1. CLAIM   up to K due rows nobody else holds        (MySQL)
  2. for each claimed row:
       a. take a rate-limit slot for its tenant         (Redis)
       b. POST /send with Idempotency-Key               (provider)
       c. RECORD the result, only if I still own the row (MySQL)
          (200 / 200-duplicate → sent; 409 in-progress → retry later)
  3. if nothing was claimed, sleep briefly
```

**Claim** (one transaction, `READ COMMITTED`, in [message.model.js](service/src/models/message.model.js) `claimMessages`). It uses two plain indexed selects instead of one `OR`, so each can use its own index:

```sql
-- 1. abandoned by a dead/stalled worker
SELECT id, attempts FROM messages
WHERE status = 'in_progress' AND lease_until < NOW(3)
ORDER BY lease_until LIMIT K FOR UPDATE SKIP LOCKED;
--    rows that already used all attempts → marked failed instead of reclaimed

-- 2. due pending messages (fills the rest of the batch)
SELECT id FROM messages
WHERE status = 'pending' AND next_attempt_at <= NOW(3)
ORDER BY next_attempt_at LIMIT K' FOR UPDATE SKIP LOCKED;

UPDATE messages
SET status = 'in_progress',
    lease_until = NOW(3) + INTERVAL <lease> MICROSECOND,   -- WORKER_LEASE_MS, default 30s
    claim_token = ?,                                       -- random UUID per claim
    attempts = attempts + 1
WHERE id IN (...);
```

- `next_attempt_at` is initialised to the campaign's `send_at` and only ever moves later (backoff), so this one predicate enforces both "no early send" and backoff.
- `SKIP LOCKED` hands concurrent workers **different** rows; nobody waits and nobody gets a duplicate.
- Each worker keeps up to `WORKER_MAX_IN_FLIGHT` messages in progress and processes each independently, so one slow provider call never holds up the rest.
- The row lock lasts only for the claim transaction. During the provider call, no lock is held; the `in_progress` status and the lease protect the row.

**Record** (every outcome write is guarded by the claim token):

```sql
UPDATE messages SET status = 'sent', sent_at = NOW(3), lease_until = NULL, claim_token = NULL
WHERE id = ? AND claim_token = ? AND status = 'in_progress';
```

If the worker has lost ownership (its lease expired and someone else claimed the row), the write changes 0 rows and is discarded. Only the current owner can record a result.

**MySQL notes:**
- Worker transactions run under `READ COMMITTED` to avoid `REPEATABLE READ` gap locks, which would make workers block each other on rows neither wants.
- Indexes match the claim predicates, so MySQL locks only the rows it reads.
- All time columns are `DATETIME(3)` and all comparisons use `NOW(3)` (millisecond precision).

### 2. No early send

- The claim query filters on `next_attempt_at <= NOW(3)` (which starts at `send_at`), using the **database clock** and never a worker's local clock.
- `send_at` must carry an explicit timezone (`Z` or `±hh:mm`), and MySQL runs in UTC, so "10:00" can never silently mean server-local time.
- A message can only be sent after it's claimed, and it can only be claimed once `send_at` has passed.
- All processes run on one host, so clock skew between the DB, the workers and the provider is negligible. The test compares the provider's own receive timestamps with `send_at`.

### 3. Worker crash (kill -9)

No heartbeats, no registry of live workers, no sweeper process. Recovery is one extra condition in the normal claim query:

```sql
OR (status = 'in_progress' AND lease_until < NOW(3))
```

```
t=0s   A claims msg 17 → in_progress, lease_until t+30s, token T1
t=1s   A calls provider → provider accepts and records key 42:user_17
t=1s   kill -9 A   (before it records "sent")
...    msg 17 stays in_progress: its lease is still valid
t=30s  lease expires → B's next poll picks msg 17 up, token T2
t=30s  B calls provider with the same key → "already accepted" (200)
t=30s  B records sent (token T2 matches) ✓   provider total for this key: 1
```

- **Not stuck:** an expired lease is claimable by any worker on its next poll.
- **Not sent twice:** the takeover reuses the same Idempotency-Key.
- **Slow (not dead) worker:** if A wakes up after B took over, A's write fails the `claim_token` check.
- **Lease (30s) is much longer than the provider call timeout**, so a healthy worker never loses a message mid-call.
- `attempts` increments at claim time, so a message that keeps crashing workers can't retry forever: an expired lease on the final attempt marks the message `failed`.
- **Crash injection:** `WORKER_CRASH_AFTER_SENDS=N` makes a worker `SIGKILL` itself right after its Nth provider call and **before** recording the result, the worst possible moment.
- Workers stop starting new work `provider timeout + 2s` before their lease ends, so a provider call always finishes while the worker still owns the row.

**Considered and rejected: hash-partitioning messages across workers.** Handing a dead worker's partition to a live one still needs failure detection (timeouts), a claim to decide who takes over, and rebalancing when workers join or leave. Per-message leases give the same handover with none of the membership tracking, and a slow worker never holds up other messages.

### 4. Provider failures, timeouts and retries

[sender.js](service/src/worker/sender.js) classifies each provider response, and [processor.js](service/src/worker/processor.js) acts on it:

| Provider result | Classified as | Action |
|---|---|---|
| 200 (`accepted` or `duplicate`) | sent | mark `sent` |
| 409 (key still processing) | busy | back to `pending` in 1s, attempt **not** counted |
| 5xx, timeout (`PROVIDER_CALL_TIMEOUT_MS`, default 3s), network error | retry | back to `pending` with backoff, or `failed` after the 5th attempt |
| other 4xx | fatal | mark `failed` |

- **Backoff:** exponential, `1s, 2s, 4s, 8s…` (capped at 30s), ±20% jitter, applied by pushing `next_attempt_at` forward.
- **Max 5 attempts** (`WORKER_MAX_ATTEMPTS`), then `failed` with `last_error` set.
- **A retry never sends twice:** every attempt uses the same Idempotency-Key, so after a timeout where the provider *did* send, the retry gets `200 duplicate` and the message resolves to `sent`.
- **Not counted as attempts:** the rate limiter is unavailable (fail closed), the rate-limit wait would exceed the lease budget, or the provider returns 409.
- **Known edge:** if the 5th attempt times out, the message is marked `failed` even though the provider may have delivered it. That's inherent to an unknown outcome on the last try.

### 5. Per-tenant rate limit (shared across all workers)

**Requirement:** at most N sends per tenant in **any** one-second window, measured on provider timestamps.

**Why not a per-second counter:** N sends at `:05.9` and N more at `:06.0` each respect their own second, but the window `:05.5–:06.5` contains 2N. The same applies to a token bucket with capacity N.

**Redis sliding-window log, as one atomic Lua script per send attempt:**

```
key    rl:{tenant_id}          (sorted set)
score  send time (µs, from Redis TIME)
```

1. Remove entries older than the window.
2. If fewer than N remain, add this send and return `0`, meaning send now.
3. Otherwise return the number of ms until the oldest entry leaves the window; the worker sleeps that long and tries again.

- **Shared across workers:** Redis runs Lua scripts one at a time, so two workers can never both take the last slot.
- **Single clock:** the script uses `redis.call('TIME')`, not worker clocks.
- **Jitter margin:** the window is **1,100 ms**, not 1,000 ms. The provider timestamps on arrival, and widening the window absorbs up to about 100 ms of network delay between the worker and the provider.
- **Retries use a slot too**, like any other send.
- **N per tenant** lives in the `tenants` table. A tenant seen for the first time is created with `DEFAULT_TENANT_RATE_LIMIT` (20); workers cache N for 30s.
- **Redis down → fail closed:** the worker doesn't send. It releases the message back to `pending` without counting an attempt and tries again later.
- **Slot taken but the worker crashes before sending:** the slot is wasted, so we're slower, never over the limit. Redis and MySQL share no transaction, and this case is harmless.

**Alternative considered:** a MySQL `tenant_rate` row with even spacing. It's simpler (one stateful dependency), but it puts a hot row and an extra write per send on the main DB. Redis is the standard production answer and keeps rate-limit traffic off the main DB.

### 6. Consistency and correct counts

**Consistency over availability (CP).** If workers can't reach MySQL (or Redis), they pause instead of guessing. A late message is acceptable; a duplicate or rate-violating message is not.

**Counts are computed at read time:**

```sql
SELECT status, COUNT(*) FROM messages WHERE campaign_id = ? GROUP BY status;
```

The campaign row and the counts are read in one `REPEATABLE READ` transaction (one MVCC snapshot), so the counts always sum to the recipient total and are exact for a single moment, never "eventually" correct. There's no separate counter table to drift or to contend on. An index on `(campaign_id, status)` keeps it cheap.

**Campaign status is derived, not stored.** Only `scheduled` / `cancelled` (user intent) are stored. The API reports:

- `cancelled`: cancel was requested;
- `completed`: nothing left `pending` or `in_progress`;
- `scheduled`: `send_at` is in the future;
- `running`: otherwise.

A message whose worker died shows as `in_progress` until it's reclaimed. That is the true state: its outcome isn't known yet.

---

## Mock provider

A small standalone Express server that stands in for a real provider (Twilio, SendGrid, …). It delivers nothing; it records which Idempotency-Keys it accepted and when. Its records are the evidence the test checks.

### Dedup: reserve the key *before* doing the work

The dangerous case is two requests with the same key **overlapping**. For example, worker A's call is slow, A's lease expires, and worker B retries while the provider is still processing A's request. If the provider did *check → send → record*, both requests would pass the check and the message would go out twice.

So each key is **reserved atomically on arrival**, and has three states:

| Key state on arrival | Response | Sends? |
|---|---|---|
| not seen | reserve as `processing`, send, mark `accepted` + timestamp → **200** | yes |
| `processing`, reserved < TTL ago | **409** in progress; the worker treats it as "retry later" | no |
| `processing`, reserved ≥ TTL ago (stale) | take over the reservation and process as new | yes |
| `accepted` | **200 `{ "status": "duplicate" }`** | no |

**The two states expire differently:**

- **`processing` has a TTL** (`PROVIDER_PROCESSING_TTL_MS`, default 30s). If the work never finishes, the key would otherwise return 409 forever, and the message would end up `failed` without ever being sent. After the TTL, the next request takes the key over.
- **`accepted` never expires.** The message really was sent; dropping the key would let a late retry send it again.

**Takeover is fenced.** Each reservation carries a token. If a slow original request finishes after its reservation was taken over, its token no longer matches, so it **does not send**. It replies with the key's current state instead. This is the same idea as `claim_token` on message rows. Dropping a stale reservation is safe only because, in the mock, "send" and "mark accepted" are one step: a key still in `processing` has definitely not been sent.

Verified with work time ≈ 1s and TTL = 200ms: in 6 of 10 keys a second request took over a stale reservation, the original was fenced each time, and no key was accepted twice.

A duplicate must return **200, not an error**, so a retry after an unknown outcome (timeout or crash) resolves the message to `sent`. The same pattern is used by Stripe-style idempotency keys.

### Failure injection

- **20% errors:** decided **before** the key is reserved, so a 500 never leaves a stuck `processing` key and never counts as a send.
- **10% timeouts:** the key is reserved and recorded as `accepted` with its timestamp, then the provider never replies. The message really was sent; the caller just doesn't know it.
- The random seed is configurable for reproducible test runs.

### `GET /stats`

Every accepted send, grouped by key, with timestamps.

### Store: in-memory `Map` (Redis `SET NX` is the production choice)

The natural choice for idempotency-key dedup is **Redis `SET key processing NX`**: an atomic reserve that is shared across provider instances and survives restarts.

For the mock we deliberately use an **in-memory `Map`**:

- **Still atomic:** the mock is one Node process, and Node runs JavaScript on a single thread. The check and the reservation run with no `await` between them, so two requests can't both see "not seen".
- **Independent of the system under test:** a real provider never shares infrastructure with its clients. If the mock used *our* Redis, a flush or restart would wipe our rate-limit state and the provider's record of what it sent at the same time, and the test's evidence would no longer be independent.

In production, the provider would back this with a durable store: Redis `SET NX` with persistence, or a DB `UNIQUE` constraint on the key, and **no TTL** (or a very long one) on dedup keys, since an expired key would let a late retry send again.

---

## Repository layout

```
docker-compose.yml        MySQL 8 (UTC, schema auto-applied) + Redis 7
provider/                 mock provider: standalone package, shares no code or infra with the service
  server.js
service/
  db/schema.sql           hand-written schema: tenants, campaigns, messages (no ORM)
  src/
    server.js             API entry point
    app.js                Express app (routes + error handling)
    config.js             all settings, each overridable by env var
    db.js                 MySQL pool + transaction helper
    routes/ controllers/ services/ validators/ models/ middlewares/ utils/
    worker/
      index.js            worker entry point: claim loop, in-flight cap, crash injection
      claimer.js          claims a batch in one READ COMMITTED transaction
      rateLimiter.js      Redis sliding-window log (Lua), shared by all workers
      sender.js           provider call + response classification
      processor.js        slot → send → fenced result write, retries/backoff
```

The provider is kept as a separate package on purpose: it plays the role of an external company's server, so its records are independent evidence about what our service did.

---

## Running

Needs Node.js ≥ 20 and Docker.

```bash
# 1. MySQL + Redis. schema.sql is applied automatically on the first start
#    (empty volume). To re-apply it: docker compose down -v && docker compose up -d
docker compose up -d

# 2. Mock provider (terminal 1)
cd provider && npm install && npm start          # :4000

# 3. API (terminal 2)
cd service && npm install && npm run api         # :3000

# 4. Workers (terminals 3 and 4; run as many as you like)
cd service && WORKER_ID=w1 npm run worker
cd service && WORKER_ID=w2 npm run worker
```

### API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/campaigns` | body `{ tenant_id, channel, send_at, recipients: [user_id, ...] }` → `201` |
| `GET` | `/campaigns/:id` | `{ id, tenant_id, channel, send_at, status, counts: { pending, in_progress, sent, failed, cancelled }, total }` |
| `GET` | `/health` | checks the DB connection |
| `POST` | `/campaigns/:id/cancel` | **not implemented yet** |

Validation: `tenant_id` is a positive integer; `channel` is `sms`, `whatsapp` or `email`; `send_at` is ISO-8601 **with a timezone**; `recipients` is 1 to 100,000 strings/integers of up to 64 chars. Duplicate recipients collapse to one message. Campaign creation is atomic: all messages are written, or none.

Example: a campaign for 100 recipients, due 2 minutes from now:

```bash
RECIPIENTS=$(printf '"user%d",' $(seq 1 100)); RECIPIENTS="[${RECIPIENTS%,}]"
SEND_AT=$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)

curl -X POST localhost:3000/campaigns -H 'Content-Type: application/json' \
  -d "{\"tenant_id\":200,\"channel\":\"sms\",\"send_at\":\"$SEND_AT\",\"recipients\":$RECIPIENTS}"

curl localhost:3000/campaigns/1        # watch the counts move
curl localhost:4000/stats              # what the provider actually accepted
```

### Service configuration

| Env var | Default | Meaning |
|---|---|---|
| `API_PORT` | `3000` | API port |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `app` / `app` / `dispatcher` | MySQL (matches docker-compose) |
| `DB_POOL_SIZE` | `10` | connections per process |
| `REDIS_URL` | `redis://127.0.0.1:6379` | rate-limiter Redis |
| `PROVIDER_URL` | `http://127.0.0.1:4000` | provider base URL |
| `PROVIDER_CALL_TIMEOUT_MS` | `3000` | per-call timeout (must be far below the lease) |
| `DEFAULT_TENANT_RATE_LIMIT` | `20` | N for a tenant created on first campaign |
| `WORKER_ID` | `worker-<pid>` | name in logs and rate-limit entries |
| `WORKER_BATCH_SIZE` | `20` | max rows per claim |
| `WORKER_MAX_IN_FLIGHT` | `50` | max messages a worker processes at once |
| `WORKER_POLL_INTERVAL_MS` | `200` | sleep when there is nothing to claim |
| `WORKER_LEASE_MS` | `30000` | lease length |
| `WORKER_MAX_ATTEMPTS` | `5` | attempts before `failed` |
| `WORKER_BACKOFF_BASE_MS` / `WORKER_BACKOFF_MAX_MS` | `1000` / `30000` | exponential backoff |
| `WORKER_CRASH_AFTER_SENDS` | `0` (off) | SIGKILL self after N provider calls, before recording |
| `RATE_LIMIT_WINDOW_MS` | `1100` | sliding-window length |
| `RATE_LIMIT_TENANT_CACHE_MS` | `30000` | how long workers cache a tenant's N |

Workers log a `stats` line every 5s (claimed, reclaimed, sent, duplicates, retried, failed, busy, released, fenced).

### Mock provider configuration

```bash
cd provider && npm install && npm start      # listens on :4000
```

| Env var | Default | Meaning |
|---|---|---|
| `PROVIDER_PORT` | `4000` | port |
| `PROVIDER_ERROR_RATE` | `0.2` | share of requests answered with 500 (nothing recorded) |
| `PROVIDER_TIMEOUT_RATE` | `0.1` | share of requests recorded as sent but never answered |
| `PROVIDER_MAX_DELAY_MS` | `50` | random work time between reserving a key and accepting it |
| `PROVIDER_TIMEOUT_HOLD_MS` | `60000` | how long a timed-out request is held open before the socket is dropped |
| `PROVIDER_PROCESSING_TTL_MS` | `30000` | how long a `processing` reservation is honoured before another request may take it over |
| `PROVIDER_SEED` | random | seed for failure injection (makes runs reproducible in aggregate) |

Endpoints: `POST /send` (requires the `Idempotency-Key` header), `GET /stats`, `POST /reset` (test helper), `GET /health`.

---

## Verification

There is **no automated test suite yet** (`npm test` doesn't exist). The checks below are run by hand with the commands above; scripting them into one end-to-end test is the next step.

| Rule | How to exercise it | What to check (provider `GET /stats` + `GET /campaigns/:id`) |
|---|---|---|
| Exactly once | Two or more workers, several tenants, a few hundred recipients each | No Idempotency-Key accepted more than once; every `sent` message accepted exactly once |
| No early send | `send_at` a couple of minutes in the future | Every accepted timestamp ≥ its campaign's `send_at` |
| Worker crash | Start one worker with `WORKER_CRASH_AFTER_SENDS=50`, or `kill -9` it mid-run | After the lease (30s) the other worker reclaims its rows; all messages reach a final status; no key accepted twice |
| Retries | Default provider error/timeout rates (20% / 10%) | Messages end `sent` (some via `duplicate`) or `failed` after 5 attempts; none sent twice |
| Rate limit | Tenant N = 20 | For every tenant, no 1-second sliding window over accepted timestamps contains more than N sends |
| Counts | Poll `GET /campaigns/:id` during the run | Counts always sum to the recipient total |

---

## Not yet covered

- **Cancel:** `POST /campaigns/:id/cancel` is not implemented. The schema already has `campaigns.status = 'cancelled'`, `cancelled_at` and a `cancelled` message status. The plan: flip pending messages to `cancelled` in one transaction, let in-flight messages finish and report their true result (`sent` or `failed`), stop the claim query from picking up messages of a cancelled campaign, and make a second cancel a no-op.
- **Automated end-to-end test** for the table above.
