// SQL for messages: seeding and counts (API), claim and result writes (worker).

const INSERT_CHUNK = 1000;

/**
 * Insert one pending message per recipient.
 * next_attempt_at starts at the campaign's send_at, which is what enforces
 * "no early send" in the claim query.
 */
export async function insertMessages(conn, { campaignId, tenantId, sendAt, userIds }) {
  for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
    const rows = userIds
      .slice(i, i + INSERT_CHUNK)
      .map((userId) => [campaignId, tenantId, userId, sendAt]);
    await conn.query(
      'INSERT INTO messages (campaign_id, tenant_id, user_id, next_attempt_at) VALUES ?',
      [rows],
    );
  }
}

/** @returns {Promise<Record<string, number>>} e.g. { pending: 3, sent: 7 } */
export async function countByStatus(db, campaignId) {
  const [rows] = await db.query(
    'SELECT status, COUNT(*) AS n FROM messages WHERE campaign_id = ? GROUP BY status',
    [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

const CLAIM_COLUMNS = 'id, campaign_id, tenant_id, user_id, attempts';

/**
 * Claim up to `limit` messages for this worker. Must run inside a READ COMMITTED
 * transaction (see worker/claimer.js).
 *
 * Two branches, each a plain indexed SELECT ... FOR UPDATE SKIP LOCKED, so
 * concurrent workers get disjoint rows and never wait on each other:
 *   1. in_progress rows whose lease expired: their worker died or stalled.
 *   2. pending rows that are due (next_attempt_at <= now, which is >= send_at).
 *
 * Expired rows that already used every attempt are marked failed instead of
 * being claimed again.
 *
 * @returns {Promise<{ rows: object[], reclaimed: number, exhausted: number }>}
 */
export async function claimMessages(conn, { limit, leaseMs, token, maxAttempts }) {
  const [expired] = await conn.query(
    `SELECT id, attempts FROM messages
      WHERE status = 'in_progress' AND lease_until < NOW(3)
      ORDER BY lease_until
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  const exhaustedIds = expired.filter((r) => r.attempts >= maxAttempts).map((r) => r.id);
  const reclaimIds = expired.filter((r) => r.attempts < maxAttempts).map((r) => r.id);

  if (exhaustedIds.length) {
    await conn.query(
      `UPDATE messages
          SET status = 'failed', lease_until = NULL, claim_token = NULL,
              last_error = 'lease expired during final attempt'
        WHERE id IN (?)`,
      [exhaustedIds],
    );
  }

  let dueIds = [];
  const remaining = limit - reclaimIds.length;
  if (remaining > 0) {
    const [due] = await conn.query(
      `SELECT id FROM messages
        WHERE status = 'pending' AND next_attempt_at <= NOW(3)
        ORDER BY next_attempt_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [remaining],
    );
    dueIds = due.map((r) => r.id);
  }

  const ids = [...reclaimIds, ...dueIds];
  if (ids.length === 0) return { rows: [], reclaimed: 0, exhausted: exhaustedIds.length };

  await conn.query(
    `UPDATE messages
        SET status = 'in_progress',
            lease_until = NOW(3) + INTERVAL ? MICROSECOND,
            claim_token = ?,
            attempts = attempts + 1
      WHERE id IN (?)`,
    [leaseMs * 1000, token, ids],
  );

  const [rows] = await conn.query(`SELECT ${CLAIM_COLUMNS} FROM messages WHERE id IN (?)`, [ids]);
  return { rows, reclaimed: reclaimIds.length, exhausted: exhaustedIds.length };
}

// Every result write below is fenced: it only applies if this worker's claim is
// still the current one. Each returns true if it applied, false if ownership was
// lost (lease expired and another worker reclaimed the row).

const OWNED = "id = ? AND claim_token = ? AND status = 'in_progress'";

export async function markSent(db, id, token) {
  const [r] = await db.query(
    `UPDATE messages
        SET status = 'sent', sent_at = NOW(3), lease_until = NULL, claim_token = NULL, last_error = NULL
      WHERE ${OWNED}`,
    [id, token],
  );
  return r.affectedRows === 1;
}

export async function markFailed(db, id, token, error) {
  const [r] = await db.query(
    `UPDATE messages
        SET status = 'failed', lease_until = NULL, claim_token = NULL, last_error = ?
      WHERE ${OWNED}`,
    [String(error).slice(0, 255), id, token],
  );
  return r.affectedRows === 1;
}

/** Back to pending after a failed attempt; the attempt stays counted. */
export async function scheduleRetry(db, id, token, delayMs, error) {
  const [r] = await db.query(
    `UPDATE messages
        SET status = 'pending', next_attempt_at = NOW(3) + INTERVAL ? MICROSECOND,
            lease_until = NULL, claim_token = NULL, last_error = ?
      WHERE ${OWNED}`,
    [Math.round(delayMs * 1000), String(error).slice(0, 255), id, token],
  );
  return r.affectedRows === 1;
}

/**
 * Back to pending WITHOUT counting the attempt: used when the provider was not
 * actually tried (rate limiter unavailable, lease budget used up) or when the
 * provider says another request for this key is still in progress (409).
 */
export async function releaseClaim(db, id, token, delayMs, reason) {
  const [r] = await db.query(
    `UPDATE messages
        SET status = 'pending', next_attempt_at = NOW(3) + INTERVAL ? MICROSECOND,
            attempts = GREATEST(attempts - 1, 0),
            lease_until = NULL, claim_token = NULL, last_error = ?
      WHERE ${OWNED}`,
    [Math.round(delayMs * 1000), String(reason).slice(0, 255), id, token],
  );
  return r.affectedRows === 1;
}
