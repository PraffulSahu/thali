/** DEMO-ONLY SMS provider: logs `[DEMO] would send`, never the body or the full number. */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { maskPhone } from '../domain/templates.js';
import { ProviderSendError } from './errors.js';
import type { FailModeReader } from './fail-mode.js';
import type { SendResult, SmsMessage, SmsProvider } from './sms.js';

export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock' as const;
  constructor(private readonly deps: { logger: Logger; failMode?: FailModeReader }) {}

  async send(msg: SmsMessage): Promise<SendResult> {
    if ((await this.deps.failMode?.get())?.sms) {
      throw new ProviderSendError('mock', 'simulated SMS provider outage (demo fail mode)', { retryable: true, status: 503 });
    }
    const providerMessageId = `mock-${randomUUID()}`;
    this.deps.logger.info({ channel: 'SMS', to: maskPhone(msg.to), notificationId: msg.notificationId, providerMessageId, simulated: true }, '[DEMO] would send sms');
    return { providerMessageId };
  }
}
