/**
 * Twilio SMS (Programmable Messaging).
 *  - Send:    POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *             application/x-www-form-urlencoded: To, From | MessagingServiceSid, Body, StatusCallback;
 *             HTTP basic auth AccountSid:AuthToken.   https://www.twilio.com/docs/messaging/api/message-resource
 *  - Webhook: X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(name+value ...)))
 *             https://www.twilio.com/docs/usage/webhooks/webhooks-security  (algorithm mirrors twilio-node
 *             `getExpectedTwilioSignature` / `validateRequest`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderSendError, isRetryableStatus, scrubMessage } from './errors.js';
import type { SendResult, SmsMessage, SmsProvider } from './sms.js';

export const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export interface TwilioSmsOptions {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
  /** Default StatusCallback when the message does not carry one. */
  statusCallbackUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TwilioSmsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    if (!opts.from && !opts.messagingServiceSid) throw new Error('TwilioSmsProvider: from or messagingServiceSid is required');
  }

  async send(msg: SmsMessage): Promise<SendResult> {
    const { accountSid, authToken } = this.opts;
    const form = new URLSearchParams();
    form.set('To', msg.to);
    if (this.opts.messagingServiceSid) form.set('MessagingServiceSid', this.opts.messagingServiceSid);
    else form.set('From', this.opts.from!);
    form.set('Body', msg.body);
    const callback = msg.statusCallbackUrl ?? this.opts.statusCallbackUrl;
    if (callback) form.set('StatusCallback', callback);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl ?? TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new ProviderSendError('twilio', `request failed: ${err instanceof Error ? err.name : 'error'}`, { retryable: true, cause: err });
    }

    let json: { sid?: unknown; code?: unknown; message?: unknown } | undefined;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw new ProviderSendError('twilio', scrubMessage(json?.message) || `HTTP ${res.status}`, {
        retryable: isRetryableStatus(res.status),
        status: res.status,
        code: typeof json?.code === 'number' || typeof json?.code === 'string' ? json.code : undefined,
      });
    }
    if (typeof json?.sid !== 'string') {
      throw new ProviderSendError('twilio', 'response had no message sid', { retryable: true, status: res.status });
    }
    return { providerMessageId: json.sid };
  }
}

type TwilioParams = Record<string, string | string[] | undefined>;

/** `url + name1value1name2value2...` with names sorted; duplicate names: unique values sorted (twilio-node). */
export function twilioSignature(authToken: string, url: string, params: TwilioParams = {}): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined) continue;
    data += Array.isArray(v) ? [...new Set(v)].sort().map((x) => key + x).join('') : key + v;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Twilio signs the URL it was configured with; proxies may add/drop the default port (like twilio-node). */
function urlCandidates(raw: string): string[] {
  const out = new Set<string>([raw]);
  try {
    const u = new URL(raw);
    const standard = u.protocol === 'https:' ? '443' : '80';
    const tail = `${u.pathname}${u.search}`;
    out.add(`${u.protocol}//${u.hostname}${tail}`);
    out.add(`${u.protocol}//${u.hostname}:${standard}${tail}`);
  } catch {
    /* only the raw url */
  }
  return [...out];
}

export function validateTwilioSignature(authToken: string, signature: string | undefined | null, url: string, params: TwilioParams): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  let ok = false;
  for (const candidate of urlCandidates(url)) {
    const expected = Buffer.from(twilioSignature(authToken, candidate, params));
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}
