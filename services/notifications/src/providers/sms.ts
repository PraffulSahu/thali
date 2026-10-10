/** SMS provider port + factory (`SMS_PROVIDER=twilio|mock`). */
import type { Logger } from 'pino';
import { ConfigError } from '@thali/service-kit';
import type { NotificationsConfig } from '../config.js';
import { twilioStatusCallbackUrl } from '../config.js';
import type { FailModeReader } from './fail-mode.js';
import { MockSmsProvider } from './mock-sms.js';
import { TwilioSmsProvider } from './twilio-sms.js';

export interface SmsMessage {
  /** E.164. */
  to: string;
  body: string;
  notificationId: string;
  /** Overrides the provider's default status callback URL. */
  statusCallbackUrl?: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface SmsProvider {
  readonly name: 'twilio' | 'mock';
  send(msg: SmsMessage): Promise<SendResult>;
}

export function createSmsProvider(
  config: NotificationsConfig,
  deps: { logger: Logger; failMode?: FailModeReader; fetch?: typeof fetch },
): SmsProvider {
  if (config.SMS_PROVIDER === 'mock') {
    if (config.APP_MODE === 'production') throw new ConfigError(['SMS_PROVIDER: mock is not allowed in production']);
    return new MockSmsProvider({ logger: deps.logger, failMode: deps.failMode });
  }
  return new TwilioSmsProvider({
    accountSid: config.TWILIO_ACCOUNT_SID!,
    authToken: config.TWILIO_AUTH_TOKEN!,
    from: config.TWILIO_FROM,
    messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
    statusCallbackUrl: twilioStatusCallbackUrl(config),
    timeoutMs: config.PROVIDER_TIMEOUT_MS,
    fetch: deps.fetch,
  });
}
