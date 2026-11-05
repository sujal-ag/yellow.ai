// Calls the provider and classifies the result. No DB access here.
//
// The Idempotency-Key is derived from the message's identity, never generated
// per attempt, so every retry and every takeover by another worker sends the
// same key. The provider accepts each key once: that is what makes retries safe.

import { config } from '../config.js';

export const idempotencyKey = (msg) => `${msg.campaign_id}:${msg.user_id}`;

/**
 * @returns {Promise<
 *   | { kind: 'sent', detail: string }        200: accepted now, or already accepted earlier
 *   | { kind: 'busy' }                        409: another request for this key is in flight
 *   | { kind: 'retry', error: string }        5xx, timeout, network error: outcome unknown or failed
 *   | { kind: 'fatal', error: string }        other 4xx: our request is wrong, retrying won't help
 * >}
 */
export async function sendToProvider(msg) {
  let res;
  try {
    res = await fetch(`${config.provider.url}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey(msg),
      },
      body: JSON.stringify({
        tenant_id: msg.tenant_id,
        campaign_id: msg.campaign_id,
        user_id: msg.user_id,
      }),
      signal: AbortSignal.timeout(config.provider.timeoutMs),
    });
  } catch (err) {
    // Timeout: the provider may or may not have sent it. Retrying with the same
    // key is safe either way.
    const error = err.name === 'TimeoutError' ? 'timeout' : `network: ${err.cause?.code ?? err.message}`;
    return { kind: 'retry', error };
  }

  const body = await res.json().catch(() => ({}));

  if (res.ok) return { kind: 'sent', detail: body.status ?? 'accepted' };
  if (res.status === 409) return { kind: 'busy' };
  if (res.status >= 500) return { kind: 'retry', error: `provider ${res.status}` };
  return { kind: 'fatal', error: `provider ${res.status}: ${body.error ?? 'rejected'}` };
}
