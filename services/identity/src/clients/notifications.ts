/**
 * notifications client (binding shapes):
 * - `POST /internal/notifications/otp {phone, code}` → 202 `{notificationId}`; 503 `OTP_DELIVERY_FAILED`
 *   when the provider fails. Any failure (including timeouts / connection errors) surfaces as 503
 *   `OTP_DELIVERY_FAILED`.
 * - `POST /internal/notifications/send {channel, to, template, data, dedupeKey}` → 202 `{notificationId}`
 *   (queued; idempotent by dedupeKey). Used for the admin password-reset email (contract 6). Errors are
 *   rethrown as-is (the caller decides; forgot-password only logs them).
 */
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient } from '@thali/service-kit';
import type { IdentityConfig } from '../config.js';

export interface NotificationsClient {
  /** Synchronous OTP send; throws DomainError(OTP_DELIVERY_FAILED) on any failure. */
  sendOtp(phone: string, code: string): Promise<void>;
  /** Queue a templated notification (`/internal/notifications/send`). Throws on any failure. */
  send(input: SendNotificationInput): Promise<{ notificationId: string }>;
}

export interface SendNotificationInput {
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  to?: string;
  userId?: string;
  template: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

/** Template owned by notifications (Task 5): subject "Reset your Thali admin password"; data `{resetUrl, expiresMinutes}`. */
export const ADMIN_PASSWORD_RESET_TEMPLATE = 'ADMIN_PASSWORD_RESET';

const OtpAccepted = z.object({ notificationId: z.string() });

export function createNotificationsClient(
  config: Pick<IdentityConfig, 'NOTIFICATIONS_URL' | 'INTERNAL_SERVICE_SECRET'>,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): NotificationsClient {
  const client = internalClient('notifications', config.NOTIFICATIONS_URL, {
    from: 'identity',
    secret: config.INTERNAL_SERVICE_SECRET,
    timeoutMs: opts.timeoutMs ?? 10_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    async sendOtp(phone, code) {
      try {
        await client.post('/internal/notifications/otp', { phone, code }, { schema: OtpAccepted });
      } catch (err) {
        throw new DomainError('OTP_DELIVERY_FAILED', 'Could not send the verification code. Please try again.', undefined, {
          cause: err instanceof DomainError ? err.code : 'UNKNOWN',
        });
      }
    },
    async send(input) {
      return client.post('/internal/notifications/send', input, { schema: OtpAccepted });
    },
  };
}
