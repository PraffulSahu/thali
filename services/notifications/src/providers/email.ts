/** Email provider port + factory (`EMAIL_PROVIDER=resend|mailpit|mock`). */
import type { Logger } from 'pino';
import { ConfigError } from '@thali/service-kit';
import type { NotificationsConfig } from '../config.js';
import type { FailModeReader } from './fail-mode.js';
import type { SendResult } from './sms.js';
import { MailpitEmailProvider } from './mailpit-email.js';
import { MockEmailProvider } from './mock-email.js';
import { ResendEmailProvider } from './resend-email.js';

export interface EmailMessage {
  /** Plain address, e.g. `asha@example.com`. */
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The notification `dedupeKey`: Resend `Idempotency-Key` so retries never send twice. */
  idempotencyKey: string;
  notificationId: string;
}

export interface EmailProvider {
  readonly name: 'resend' | 'mailpit' | 'mock';
  send(msg: EmailMessage): Promise<SendResult>;
}

export function createEmailProvider(
  config: NotificationsConfig,
  deps: { logger: Logger; failMode?: FailModeReader; fetch?: typeof fetch },
): EmailProvider {
  switch (config.EMAIL_PROVIDER) {
    case 'resend':
      return new ResendEmailProvider({ apiKey: config.RESEND_API_KEY!, from: config.EMAIL_FROM, timeoutMs: config.PROVIDER_TIMEOUT_MS, fetch: deps.fetch });
    case 'mailpit':
      if (config.APP_MODE === 'production') throw new ConfigError(['EMAIL_PROVIDER: mailpit is not allowed in production']);
      return new MailpitEmailProvider({ baseUrl: config.MAILPIT_URL, from: config.EMAIL_FROM, timeoutMs: config.PROVIDER_TIMEOUT_MS, fetch: deps.fetch });
    case 'mock':
      if (config.APP_MODE === 'production') throw new ConfigError(['EMAIL_PROVIDER: mock is not allowed in production']);
      return new MockEmailProvider({ logger: deps.logger, failMode: deps.failMode });
  }
}
