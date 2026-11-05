// SQL for tenants.

/**
 * Create the tenant with a default rate limit if it doesn't exist yet.
 * Existing tenants keep their configured limit.
 */
export async function ensureTenant(conn, tenantId, defaultRateLimit) {
  await conn.query(
    'INSERT IGNORE INTO tenants (id, rate_limit_per_sec) VALUES (?, ?)',
    [tenantId, defaultRateLimit],
  );
}

/** @returns {Promise<number | null>} N for the tenant, or null if unknown. */
export async function getRateLimit(db, tenantId) {
  const [rows] = await db.query('SELECT rate_limit_per_sec FROM tenants WHERE id = ?', [tenantId]);
  return rows.length ? rows[0].rate_limit_per_sec : null;
}
