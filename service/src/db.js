// MySQL connection pool + transaction helper.

import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  // Treat DATETIME values as UTC on the way in and out (server runs in UTC too).
  timezone: 'Z',
  waitForConnections: true,
});

/**
 * Run `fn(conn)` inside a transaction on one pooled connection.
 * Commits if `fn` resolves, rolls back if it throws, always releases the connection.
 *
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @param {{ isolation?: 'READ COMMITTED' | 'REPEATABLE READ' }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withTransaction(fn, { isolation } = {}) {
  const conn = await pool.getConnection();
  try {
    if (isolation) {
      // Applies to the next transaction on this connection only.
      await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    }
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
