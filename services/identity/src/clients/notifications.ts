/**
 * notifications client (binding shape): `POST /internal/notifications/otp {phone, code}` → 202
 * `{notificationId}`; 503 `OTP_DELIVERY_FAILED` when the provider fails. Any failure (including
 * timeouts / connection errors) surfaces as 503 `OTP_DELIVERY_FAILED`.
 */
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient } from '@thali/service-kit';
import type { IdentityConfig } from '../config.js';

export interface NotificationsClient {
  /** Synchronous OTP send; throws DomainError(OTP_DELIVERY_FAILED) on any failure. */
  sendOtp(phone: string, code: string): Promise<void>;
}

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
  };
}
