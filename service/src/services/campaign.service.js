// Business rules for campaigns. Owns transactions; delegates SQL to models.

import { withTransaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import * as tenants from '../models/tenant.model.js';
import * as campaigns from '../models/campaign.model.js';
import * as messages from '../models/message.model.js';

const STATUSES = ['pending', 'in_progress', 'sent', 'failed', 'cancelled'];

/**
 * Create a campaign and all its messages atomically: either every recipient
 * becomes a pending message, or nothing is written.
 */
export async function createCampaign({ tenantId, channel, sendAt, userIds }) {
  const id = await withTransaction(async (conn) => {
    await tenants.ensureTenant(conn, tenantId, config.defaultTenantRateLimit);
    const campaignId = await campaigns.insertCampaign(conn, { tenantId, channel, sendAt });
    await messages.insertMessages(conn, { campaignId, tenantId, sendAt, userIds });
    return campaignId;
  });

  return {
    id,
    tenant_id: tenantId,
    channel,
    send_at: sendAt.toISOString(),
    status: sendAt.getTime() > Date.now() ? 'scheduled' : 'running',
    recipients: userIds.length,
  };
}

/**
 * Campaign status + per-status message counts.
 *
 * Both reads run in one REPEATABLE READ transaction, so they come from the same
 * snapshot: the counts always sum to the recipient total and always agree with
 * the campaign status. They are exact for that instant, never "eventually" correct.
 */
export async function getCampaign(id) {
  return withTransaction(
    async (conn) => {
      const campaign = await campaigns.findCampaignById(conn, id);
      if (!campaign) throw new HttpError(404, `Campaign ${id} not found`);

      const raw = await messages.countByStatus(conn, id);
      const counts = Object.fromEntries(STATUSES.map((s) => [s, raw[s] ?? 0]));

      return {
        id: campaign.id,
        tenant_id: campaign.tenant_id,
        channel: campaign.channel,
        send_at: campaign.send_at.toISOString(),
        status: deriveStatus(campaign, counts),
        counts,
        total: STATUSES.reduce((sum, s) => sum + counts[s], 0),
      };
    },
    { isolation: 'REPEATABLE READ' },
  );
}

/**
 * Only 'scheduled' / 'cancelled' are stored; the rest is derived from counts so
 * it can never drift:
 *   cancelled  - cancel was requested
 *   completed  - nothing left pending or in progress
 *   scheduled  - send_at is in the future
 *   running    - otherwise
 */
function deriveStatus(campaign, counts) {
  if (campaign.status === 'cancelled') return 'cancelled';
  if (counts.pending + counts.in_progress === 0) return 'completed';
  if (campaign.send_at.getTime() > Date.now()) return 'scheduled';
  return 'running';
}
