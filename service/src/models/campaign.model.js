// SQL for campaigns.

/** @returns {Promise<number>} the new campaign id */
export async function insertCampaign(conn, { tenantId, channel, sendAt }) {
  const [result] = await conn.query(
    'INSERT INTO campaigns (tenant_id, channel, send_at) VALUES (?, ?, ?)',
    [tenantId, channel, sendAt],
  );
  return result.insertId;
}

export async function findCampaignById(db, id) {
  const [rows] = await db.query(
    'SELECT id, tenant_id, channel, send_at, status, cancelled_at, created_at FROM campaigns WHERE id = ?',
    [id],
  );
  return rows[0] ?? null;
}
