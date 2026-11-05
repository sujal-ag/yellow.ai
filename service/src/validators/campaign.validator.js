// Request validation for campaign endpoints. Returns clean values or throws 400.

import { HttpError } from '../utils/httpError.js';

const CHANNELS = ['sms', 'whatsapp', 'email'];
const MAX_RECIPIENTS = 100_000;
const MAX_USER_ID_LENGTH = 64; // matches messages.user_id VARCHAR(64)

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

export function parseCampaignId(raw) {
  const id = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !isPositiveInt(id)) {
    throw new HttpError(400, 'Campaign id must be a positive integer');
  }
  return id;
}

/**
 * @returns {{ tenantId: number, channel: string, sendAt: Date, userIds: string[] }}
 */
export function parseCreateCampaign(body) {
  const errors = [];
  const { tenant_id, channel, send_at, recipients } = body ?? {};

  if (!isPositiveInt(tenant_id)) errors.push('tenant_id must be a positive integer');

  if (!CHANNELS.includes(channel)) errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);

  // Require an explicit timezone so "10:00" can't silently mean server-local time.
  const sendAt = typeof send_at === 'string' ? new Date(send_at) : null;
  if (!sendAt || Number.isNaN(sendAt.getTime()) || !/(Z|[+-]\d{2}:?\d{2})$/.test(send_at)) {
    errors.push('send_at must be an ISO-8601 timestamp with a timezone, e.g. 2026-11-05T10:00:00Z');
  }

  let userIds = [];
  if (!Array.isArray(recipients) || recipients.length === 0) {
    errors.push('recipients must be a non-empty array of user ids');
  } else if (recipients.length > MAX_RECIPIENTS) {
    errors.push(`recipients may contain at most ${MAX_RECIPIENTS} entries`);
  } else {
    const bad = recipients.filter(
      (r) => !(typeof r === 'string' || Number.isSafeInteger(r)) || String(r).length === 0
        || String(r).length > MAX_USER_ID_LENGTH,
    );
    if (bad.length) {
      errors.push(`each recipient must be a non-empty string or integer of at most ${MAX_USER_ID_LENGTH} chars`);
    }
    // A recipient appears in a campaign once (UNIQUE (campaign_id, user_id)),
    // so duplicates in the request collapse to one message.
    userIds = [...new Set(recipients.map(String))];
  }

  if (errors.length) throw new HttpError(400, 'Invalid campaign', errors);
  return { tenantId: tenant_id, channel, sendAt, userIds };
}
