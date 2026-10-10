/**
 * Payment provider port (ADR-009). Razorpay is the real adapter; the mock adapter (ADR-011) speaks the
 * same Razorpay-shaped webhook format so both run through one verification/dedupe pipeline.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@thali/contracts';

export type ProviderName = 'razorpay' | 'mock';

export interface ProviderPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  captured: boolean;
  createdAt: Date;
  errorDescription?: string;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: 'pending' | 'processed' | 'failed';
  notes: Record<string, string>;
  receipt?: string | null;
}

export type NormalizedEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'order.paid'
  | 'refund.processed'
  | 'refund.failed';

export interface NormalizedEvent {
  /** Provider event id when carried in the body (Razorpay sends it in the `x-razorpay-event-id` header instead). */
  eventId?: string;
  type: NormalizedEventType;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  amountPaise: number;
  currency: string;
  createdAt: Date;
  /** Notes of the primary entity (order notes for order.paid, refund notes for refund.*). */
  notes: Record<string, string>;
  /** Order receipt (order.paid only). */
  receipt?: string | null;
  /** Failure description (payment.failed / refund.failed). */
  reason?: string;
}

export interface CreateOrderInput {
  amountPaise: number;
  currency: 'INR';
  /** ≤ 40 chars (Razorpay). */
  receipt: string;
  notes: Record<string, string>;
}

export interface RefundInput {
  paymentId: string;
  amountPaise: number;
  /** Provider-level idempotency key (Razorpay `X-Refund-Idempotency`, ≥10 chars `[A-Za-z0-9_-]`); also sent as `receipt`. */
  idempotencyKey: string;
  notes: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  /** Public key id for Standard Checkout (null for mock). */
  readonly keyId: string | null;
  createOrder(input: CreateOrderInput): Promise<{ providerOrderId: string }>;
  fetchOrderPayments(providerOrderId: string): Promise<ProviderPayment[]>;
  capture(paymentId: string, amountPaise: number): Promise<ProviderPayment>;
  refund(input: RefundInput): Promise<{ providerRefundId: string; status: ProviderRefund['status'] }>;
  fetchRefund(providerRefundId: string): Promise<ProviderRefund>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  /** Standard Checkout handler signature: HMAC-SHA256(`order_id|payment_id`, key secret). */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  parseWebhook(json: unknown): NormalizedEvent | null;
}

/**
 * Provider failure. Always surfaces as 502 `PAYMENT_PROVIDER_UNAVAILABLE`; `retryable` distinguishes
 * uncertain outcomes (timeout, network, 5xx, 409-in-progress, 429) from definitive rejections (other 4xx).
 */
export class PaymentProviderError extends DomainError {
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  constructor(message: string, opts: { retryable: boolean; status?: number; providerCode?: string; cause?: unknown }) {
    super('PAYMENT_PROVIDER_UNAVAILABLE', `Payment provider error: ${message}`);
    this.name = 'PaymentProviderError';
    this.retryable = opts.retryable;
    if (opts.status !== undefined) this.providerStatus = opts.status;
    if (opts.providerCode !== undefined) this.providerCode = opts.providerCode;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Constant-time comparison of a hex HMAC-SHA256 signature. */
export function verifyHexHmac(secret: string, data: string | Buffer, signature: string): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const expected = createHmac('sha256', secret).update(data).digest();
  const given = Buffer.from(signature.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signHexHmac(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : Number.NaN);
const tsDate = (v: unknown): Date => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : new Date());

/** Razorpay `notes` is an object, or `[]` when empty; keep string values only. */
export function normalizeNotes(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string' || typeof val === 'number') out[k] = String(val);
  return out;
}

function entity(payload: Obj, name: string): Obj | undefined {
  const holder = payload[name];
  return isObj(holder) && isObj(holder.entity) ? holder.entity : undefined;
}

/** Map a Razorpay webhook body (https://razorpay.com/docs/webhooks/payloads/) to a NormalizedEvent; unsupported → null. */
export function parseRazorpayWebhook(json: unknown): NormalizedEvent | null {
  if (!isObj(json) || !isObj(json.payload)) return null;
  const type = json.event;
  const createdAt = tsDate(json.created_at);
  const payload = json.payload;
  switch (type) {
    case 'payment.authorized':
    case 'payment.captured':
    case 'payment.failed': {
      const p = entity(payload, 'payment');
      if (!p) return null;
      const reason = str(p.error_description) ?? str(p.error_reason);
      return {
        type,
        providerOrderId: str(p.order_id),
        providerPaymentId: str(p.id),
        amountPaise: int(p.amount),
        currency: String(p.currency ?? ''),
        createdAt,
        notes: normalizeNotes(p.notes),
        ...(type === 'payment.failed' && reason ? { reason } : {}),
      };
    }
    case 'order.paid': {
      const o = entity(payload, 'order');
      const p = entity(payload, 'payment');
      if (!o) return null;
      return {
        type,
        providerOrderId: str(o.id),
        providerPaymentId: p ? str(p.id) : undefined,
        amountPaise: int(p ? p.amount : o.amount_paid),
        currency: String((p ?? o).currency ?? ''),
        createdAt,
        notes: normalizeNotes(o.notes),
        receipt: str(o.receipt) ?? null,
      };
    }
    case 'refund.processed':
    case 'refund.failed': {
      const r = entity(payload, 'refund');
      if (!r) return null;
      return {
        type,
        providerRefundId: str(r.id),
        providerPaymentId: str(r.payment_id),
        amountPaise: int(r.amount),
        currency: String(r.currency ?? ''),
        createdAt,
        notes: normalizeNotes(r.notes),
        ...(type === 'refund.failed' ? { reason: 'Provider reported refund failure' } : {}),
      };
    }
    default:
      return null;
  }
}

/** Strip optional undefined keys so normalized events compare cleanly. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
