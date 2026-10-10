/**
 * Resend email.
 *  - Send:    POST https://api.resend.com/emails  (Bearer key; JSON {from,to,subject,html,text};
 *             `Idempotency-Key` header, max 256 chars, 24 h)   https://resend.com/docs/api-reference/emails/send-email
 *  - Errors:  https://resend.com/docs/api-reference/errors  (409 invalid_idempotent_request is permanent,
 *             the other 409s, 429 and 5xx are transient)
 *  - Webhook: Svix signatures  https://resend.com/docs/webhooks/verify-webhooks-requests
 *             https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailMessage, EmailProvider } from './email.js';
import { ProviderSendError, isRetryableStatus, scrubMessage } from './errors.js';
import type { SendResult } from './sms.js';

export const RESEND_API_URL = 'https://api.resend.com/emails';

export interface ResendEmailOptions {
  apiKey: string;
  /** `Name <addr@domain>` or bare address. */
  from: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  url?: string;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendEmailOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url ?? RESEND_API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': msg.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from: this.opts.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new ProviderSendError('resend', `request failed: ${err instanceof Error ? err.name : 'error'}`, { retryable: true, cause: err });
    }
    let json: { id?: unknown; name?: unknown; message?: unknown } | undefined;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const name = typeof json?.name === 'string' ? json.name : undefined;
      const retryable = res.status === 409 ? name !== 'invalid_idempotent_request' : isRetryableStatus(res.status);
      throw new ProviderSendError('resend', scrubMessage(json?.message) || `HTTP ${res.status}`, { retryable, status: res.status, code: name });
    }
    if (typeof json?.id !== 'string') {
      throw new ProviderSendError('resend', 'response had no email id', { retryable: true, status: res.status });
    }
    return { providerMessageId: json.id };
  }
}

export const SVIX_TOLERANCE_SEC = 300;

export interface SvixVerifyInput {
  /** `whsec_<base64>`. */
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  /** `svix-signature` header: space-separated `v1,<base64>` entries. */
  signature: string | undefined;
  /** EXACT raw request body. */
  body: string | Buffer;
  /** ms since epoch (injectable). */
  now?: number;
  toleranceSec?: number;
}

/** Svix: `v1,` + base64(HMAC-SHA256(base64decode(secret w/o `whsec_`), `${id}.${timestamp}.${body}`)). */
export function verifySvixSignature(input: SvixVerifyInput): boolean {
  const { secret, id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.now ?? Date.now();
  const tolerance = input.toleranceSec ?? SVIX_TOLERANCE_SEC;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > tolerance) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]);
  const expected = createHmac('sha256', key).update(signed).digest();

  let ok = false;
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}
