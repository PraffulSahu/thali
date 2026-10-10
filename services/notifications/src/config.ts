/**
 * Notifications service configuration (LLD §12). Base vars come from service-kit `loadConfig`;
 * cross-field provider rules are enforced by `loadNotificationsConfig`.
 */
import { z } from 'zod';
import { ConfigError, envOptionalUrl, loadConfig } from '@thali/service-kit';

const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

export const notificationsShape = {
  // --- providers ---
  SMS_PROVIDER: z.enum(['twilio', 'mock']).default('mock'),
  TWILIO_ACCOUNT_SID: optionalString(),
  TWILIO_AUTH_TOKEN: optionalString(),
  TWILIO_FROM: optionalString(),
  TWILIO_MESSAGING_SERVICE_SID: optionalString(),
  /** Full public URL Twilio calls for status callbacks (also the URL the signature is computed over). */
  TWILIO_STATUS_CALLBACK_URL: envOptionalUrl(),
  EMAIL_PROVIDER: z.enum(['resend', 'mailpit', 'mock']).default('mailpit'),
  RESEND_API_KEY: optionalString(),
  RESEND_WEBHOOK_SECRET: optionalString(),
  EMAIL_FROM: z.string().min(3).default('Thali <no-reply@thali.local>'),
  MAILPIT_URL: z.url().default('http://localhost:8025'),
  // --- delivery ---
  NOTIF_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  NOTIF_RETRY_BASE_SEC: z.coerce.number().int().min(1).default(30),
  NOTIF_RETRY_MAX_SEC: z.coerce.number().int().min(1).default(900),
  /** How often the worker looks for QUEUED / retry-due notifications. */
  NOTIF_POLL_MS: z.coerce.number().int().min(50).default(1000),
  /** A notification stuck in SENDING longer than this (crashed instance) is made due again. */
  NOTIF_SENDING_TIMEOUT_SEC: z.coerce.number().int().min(10).default(120),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  /** base64, 32 bytes (AES-256-GCM): encrypts recipients and secret template data at rest. */
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  // --- realtime ---
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(10).default(20_000),
  SSE_MAX_AGE_SEC: z.coerce.number().int().min(10).default(3600),
  SSE_MAX_STREAMS_PER_USER: z.coerce.number().int().min(1).default(5),
  // --- peers (admin dead-letter aggregation, recipient lookup) ---
  IDENTITY_URL: z.url().default('http://localhost:4001'),
  MARKETPLACE_URL: z.url().default('http://localhost:4002'),
  ORDERS_URL: z.url().default('http://localhost:4003'),
  PAYMENTS_URL: z.url().default('http://localhost:4004'),
  DELIVERY_URL: z.url().default('http://localhost:4005'),
};

export type NotificationsConfig = ReturnType<typeof loadConfig<typeof notificationsShape>>;

/** Loads + validates config; throws `ConfigError` naming every bad variable. */
export function loadNotificationsConfig(env: Record<string, string | undefined> = process.env): NotificationsConfig {
  const cfg = loadConfig(notificationsShape, env);
  const issues: string[] = [];
  if (Buffer.from(cfg.FIELD_ENCRYPTION_KEY, 'base64').length !== 32) {
    issues.push('FIELD_ENCRYPTION_KEY: must be base64 of exactly 32 bytes');
  }
  if (cfg.SMS_PROVIDER === 'twilio') {
    if (!cfg.TWILIO_ACCOUNT_SID) issues.push('TWILIO_ACCOUNT_SID: required when SMS_PROVIDER=twilio');
    if (!cfg.TWILIO_AUTH_TOKEN) issues.push('TWILIO_AUTH_TOKEN: required when SMS_PROVIDER=twilio');
    if (!cfg.TWILIO_FROM && !cfg.TWILIO_MESSAGING_SERVICE_SID) {
      issues.push('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID: one is required when SMS_PROVIDER=twilio');
    }
  }
  if (cfg.EMAIL_PROVIDER === 'resend') {
    if (!cfg.RESEND_API_KEY) issues.push('RESEND_API_KEY: required when EMAIL_PROVIDER=resend');
    if (!cfg.RESEND_WEBHOOK_SECRET) issues.push('RESEND_WEBHOOK_SECRET: required when EMAIL_PROVIDER=resend');
  }
  if (cfg.APP_MODE === 'production' && cfg.EMAIL_PROVIDER === 'mailpit') {
    issues.push('EMAIL_PROVIDER: mailpit is a local test inbox and is not allowed when APP_MODE=production');
  }
  if (issues.length) throw new ConfigError(issues);
  return cfg;
}

/** Twilio status-callback URL: explicit override, else `<PUBLIC_API_URL>/api/v1/webhooks/twilio/status`. */
export function twilioStatusCallbackUrl(cfg: Pick<NotificationsConfig, 'TWILIO_STATUS_CALLBACK_URL' | 'PUBLIC_API_URL'>): string | undefined {
  if (cfg.TWILIO_STATUS_CALLBACK_URL) return cfg.TWILIO_STATUS_CALLBACK_URL;
  if (cfg.PUBLIC_API_URL) return `${cfg.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/webhooks/twilio/status`;
  return undefined;
}
