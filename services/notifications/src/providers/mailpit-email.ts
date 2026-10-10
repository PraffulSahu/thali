/**
 * Mailpit (demo inbox) via its HTTP send API: `POST {MAILPIT_URL}/api/v1/send`
 * Body (verified against https://mailpit.axllent.org/docs/api-v1/ swagger + a live instance):
 *   { From: {Email, Name?}, To: [{Email, Name?}], Subject, Text, HTML, Tags?: string[] }  -> 200 { ID }
 */
import type { EmailMessage, EmailProvider } from './email.js';
import { ProviderSendError, isRetryableStatus, scrubMessage } from './errors.js';
import type { SendResult } from './sms.js';

export interface MailpitAddress {
  Email: string;
  Name?: string;
}

/** `Name <a@b>` / `"Name, Inc" <a@b>` / bare `a@b`. */
export function parseAddress(raw: string): MailpitAddress {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) {
    const name = m[1]!.trim();
    return name ? { Email: m[2]!.trim(), Name: name } : { Email: m[2]!.trim() };
  }
  return { Email: raw.trim() };
}

export interface MailpitEmailOptions {
  baseUrl: string;
  from: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class MailpitEmailProvider implements EmailProvider {
  readonly name = 'mailpit' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MailpitEmailOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/api/v1/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          From: parseAddress(this.opts.from),
          To: [parseAddress(msg.to)],
          Subject: msg.subject,
          Text: msg.text,
          HTML: msg.html,
          Tags: ['thali'],
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new ProviderSendError('mailpit', `request failed: ${err instanceof Error ? err.name : 'error'}`, { retryable: true, cause: err });
    }
    let json: { ID?: unknown; Error?: unknown } | undefined;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw new ProviderSendError('mailpit', scrubMessage(json?.Error) || `HTTP ${res.status}`, { retryable: isRetryableStatus(res.status), status: res.status });
    }
    return { providerMessageId: typeof json?.ID === 'string' ? json.ID : `mailpit-${Date.now()}` };
  }
}
