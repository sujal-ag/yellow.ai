// Claims a batch of messages in one short transaction.

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db.js';
import { config } from '../config.js';
import { claimMessages } from '../models/message.model.js';

/**
 * READ COMMITTED avoids REPEATABLE READ's gap locks, which would make workers
 * block each other on rows neither of them wants. Row locks are held only for
 * this transaction (a few ms); after commit the lease protects the rows.
 *
 * @returns {Promise<{ token: string, claimedAt: number, rows: object[], reclaimed: number, exhausted: number }>}
 */
export async function claimBatch(limit) {
  const token = randomUUID();
  const result = await withTransaction(
    (conn) =>
      claimMessages(conn, {
        limit,
        leaseMs: config.worker.leaseMs,
        token,
        maxAttempts: config.worker.maxAttempts,
      }),
    { isolation: 'READ COMMITTED' },
  );
  return { token, claimedAt: Date.now(), ...result };
}
