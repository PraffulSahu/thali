/**
 * Payments service configuration (LLD §12). Production refuses PAYMENT_PROVIDER=mock via the kit's guard.
 */
import { z } from 'zod';
import { ConfigError, loadConfig } from '@thali/service-kit';

const optionalSecret = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional());
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

export const PaymentsConfigShape = {
  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),
  RAZORPAY_KEY_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  RAZORPAY_KEY_SECRET: optionalSecret(),
  RAZORPAY_WEBHOOK_SECRET: optionalSecret(),
  MOCK_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  /** Provider HTTP timeout. */
  PAYMENT_PROVIDER_TIMEOUT_MS: int(8000, 100),
  PAYOUT_HOLD_DAYS: int(0),
  PARTNER_BASE_PAYOUT_PAISE: int(3000),
  PARTNER_PER_KM_PAISE: int(800),
  /** Razorpay auto-capture fallback: capture AUTHORIZED payments older than this. */
  AUTHORIZED_CAPTURE_AFTER_SEC: int(300, 1),
  REFUND_MAX_ATTEMPTS: int(5, 1),
  /** Backoff base for refund retries: base·2^(attempt-1). */
  REFUND_BACKOFF_BASE_MS: int(60_000, 1),
  /** PROCESSING refunds older than this are polled via fetchRefund. */
  REFUND_POLL_AFTER_SEC: int(600, 1),
  REFUND_WORKER_INTERVAL_MS: int(5_000, 100),
  RECONCILE_INTERVAL_MS: int(60_000, 100),
  MARKETPLACE_URL: z.url().default('http://localhost:4002'),
  /** orders `GET /internal/orders/child/:id` (manual-refund ownership + per-child cap). */
  ORDERS_URL: z.url().default('http://localhost:4003'),
  /** Timeout for payments → other services internal calls. */
  INTERNAL_HTTP_TIMEOUT_MS: int(3000, 100),
} satisfies z.ZodRawShape;

function validateProvider<T extends { PAYMENT_PROVIDER: 'razorpay' | 'mock'; RAZORPAY_KEY_ID?: string; RAZORPAY_KEY_SECRET?: string; RAZORPAY_WEBHOOK_SECRET?: string; MOCK_WEBHOOK_SECRET?: string }>(cfg: T): T {
  const issues: string[] = [];
  if (cfg.PAYMENT_PROVIDER === 'razorpay') {
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
      if (!cfg[k]) issues.push(`${k}: required when PAYMENT_PROVIDER=razorpay`);
    }
  } else if (!cfg.MOCK_WEBHOOK_SECRET) {
    issues.push('MOCK_WEBHOOK_SECRET: required (min 16 chars) when PAYMENT_PROVIDER=mock');
  }
  if (issues.length) throw new ConfigError(issues);
  return cfg;
}

export function loadPaymentsConfig(env: Record<string, string | undefined> = process.env) {
  return validateProvider(loadConfig(PaymentsConfigShape, { SERVICE_NAME: 'payments', PORT: '4004', ...env }));
}

export type PaymentsConfig = ReturnType<typeof loadPaymentsConfig>;
