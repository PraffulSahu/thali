/** DEMO-ONLY email provider: logs `[DEMO] would send`, never the subject/body or the full address. */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { maskEmail } from '../domain/templates.js';
import type { EmailMessage, EmailProvider } from './email.js';
import { ProviderSendError } from './errors.js';
import type { FailModeReader } from './fail-mode.js';
import type { SendResult } from './sms.js';

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock' as const;
  constructor(private readonly deps: { logger: Logger; failMode?: FailModeReader }) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    if ((await this.deps.failMode?.get())?.email) {
      throw new ProviderSendError('mock', 'simulated email provider outage (demo fail mode)', { retryable: true, status: 503 });
    }
    const providerMessageId = `mock-${randomUUID()}`;
    this.deps.logger.info({ channel: 'EMAIL', to: maskEmail(msg.to), notificationId: msg.notificationId, providerMessageId, simulated: true }, '[DEMO] would send email');
    return { providerMessageId };
  }
}
