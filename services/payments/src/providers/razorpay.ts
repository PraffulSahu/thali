/**
 * Razorpay adapter over plain `fetch` + `AbortSignal.timeout` (ADR-009). Docs verified 2026-10-10:
 *  - Orders:   POST /v1/orders, GET /v1/orders/:id/payments       https://razorpay.com/docs/api/orders/create/
 *  - Capture:  POST /v1/payments/:id/capture {amount, currency}   https://razorpay.com/docs/api/payments/capture/
 *  - Refunds:  POST /v1/payments/:id/refund {amount, speed, notes, receipt} + `X-Refund-Idempotency`
 *              https://razorpay.com/docs/api/refunds/create-normal/ , .../refunds/normal-refunds-idempotent
 *              GET /v1/refunds/:id                                https://razorpay.com/docs/api/refunds/fetch-with-id/
 *  - Webhooks: `X-Razorpay-Signature` = hex HMAC-SHA256(raw body, webhook secret); `x-razorpay-event-id`
 *              https://razorpay.com/docs/webhooks/validate-test/
 *  - Checkout: razorpay_signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret)
 *              https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/
 * Only idempotent GETs are retried (429 honours Retry-After; network/5xx back off). POSTs are never
 * retried here: refunds are retried by the refund worker with the same provider idempotency key.
 * Never log URLs/headers/bodies here (basic-auth secret).
 */
import {
  PaymentProviderError,
  parseRazorpayWebhook,
  verifyHexHmac,
  type CreateOrderInput,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
  type RefundInput,
  normalizeNotes,
} from './payment-provider.js';

export const RAZORPAY_BASE_URL = 'https://api.razorpay.com/v1';

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Max retries for idempotent GETs (default 2 → 3 attempts). */
  maxGetRetries?: number;
  /** Cap for honoured Retry-After (default 10 s). */
  maxRetryAfterMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Called on every failed provider call (health counters). */
  onError?: (err: PaymentProviderError) => void;
}

type Json = Record<string, unknown>;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mapPayment(p: Json): ProviderPayment {
  const status = String(p.status) as ProviderPayment['status'];
  const errorDescription = typeof p.error_description === 'string' && p.error_description ? p.error_description : undefined;
  return {
    id: String(p.id),
    orderId: String(p.order_id ?? ''),
    amountPaise: Number(p.amount),
    currency: String(p.currency ?? ''),
    status,
    captured: p.captured === true || status === 'captured' || status === 'refunded',
    createdAt: new Date(Number(p.created_at ?? 0) * 1000),
    ...(errorDescription ? { errorDescription } : {}),
  };
}

function mapRefund(r: Json): ProviderRefund {
  return {
    id: String(r.id),
    paymentId: String(r.payment_id ?? ''),
    amountPaise: Number(r.amount),
    status: String(r.status) as ProviderRefund['status'],
    notes: normalizeNotes(r.notes),
    receipt: typeof r.receipt === 'string' ? r.receipt : null,
  };
}

function retryAfterMs(res: Response, fallback: number): number {
  const h = res.headers.get('retry-after');
  if (!h) return fallback;
  const sec = Number(h);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : fallback;
}

export function createRazorpayProvider(opts: RazorpayOptions): PaymentProvider {
  const base = opts.baseUrl ?? RAZORPAY_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxGetRetries = opts.maxGetRetries ?? 2;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;

  const fail = (err: PaymentProviderError): never => {
    opts.onError?.(err);
    throw err;
  };

  async function once(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
    const doFetch = opts.fetch ?? globalThis.fetch;
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const reason = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${timeoutMs} ms` : 'network error';
      return new PaymentProviderError(reason, { retryable: true, cause: err });
    }
  }

  async function call<T = Json>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const attempts = method === 'GET' ? maxGetRetries + 1 : 1;
    let last: PaymentProviderError | undefined;
    for (let i = 0; i < attempts; i++) {
      const res = await once(method, path, body, headers);
      if (res instanceof PaymentProviderError) {
        last = res;
        if (i + 1 < attempts) await sleep(200 * 2 ** i);
        continue;
      }
      const text = await res.text().catch(() => '');
      let json: Json = {};
      try {
        json = text ? (JSON.parse(text) as Json) : {};
      } catch {
        if (res.ok) return fail(new PaymentProviderError('invalid JSON response', { retryable: true, status: res.status }));
      }
      if (res.ok) return json as T;
      const errObj = (json.error ?? {}) as Json;
      const providerCode = typeof errObj.code === 'string' ? errObj.code : undefined;
      const description = typeof errObj.description === 'string' ? errObj.description.slice(0, 200) : '';
      // 429 / 5xx / 409 (idempotent request still in progress) are uncertain → retryable.
      const retryable = res.status === 429 || res.status >= 500 || res.status === 409;
      last = new PaymentProviderError(`HTTP ${res.status}${providerCode ? ` ${providerCode}` : ''}${description ? `: ${description}` : ''}`, {
        retryable,
        status: res.status,
        ...(providerCode ? { providerCode } : {}),
      });
      if (!retryable || i + 1 >= attempts) break;
      await sleep(res.status === 429 ? Math.min(retryAfterMs(res, 1000), maxRetryAfterMs) : 200 * 2 ** i);
    }
    return fail(last ?? new PaymentProviderError('unknown error', { retryable: true }));
  }

  return {
    name: 'razorpay',
    keyId: opts.keyId,

    async createOrder(input: CreateOrderInput) {
      const res = await call<Json>('POST', '/orders', {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
      });
      if (typeof res.id !== 'string') return fail(new PaymentProviderError('order id missing in response', { retryable: true }));
      return { providerOrderId: res.id };
    },

    async fetchOrderPayments(providerOrderId: string) {
      const res = await call<Json>('GET', `/orders/${encodeURIComponent(providerOrderId)}/payments`);
      const items = Array.isArray(res.items) ? (res.items as Json[]) : [];
      return items.map(mapPayment);
    },

    async capture(paymentId: string, amountPaise: number) {
      const res = await call<Json>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });
      return mapPayment(res);
    },

    async refund(input: RefundInput) {
      const res = await call<Json>(
        'POST',
        `/payments/${encodeURIComponent(input.paymentId)}/refund`,
        { amount: input.amountPaise, speed: 'normal', notes: input.notes, receipt: input.idempotencyKey },
        { 'X-Refund-Idempotency': input.idempotencyKey },
      );
      if (typeof res.id !== 'string') return fail(new PaymentProviderError('refund id missing in response', { retryable: true }));
      return { providerRefundId: res.id, status: String(res.status ?? 'pending') as ProviderRefund['status'] };
    },

    async fetchRefund(providerRefundId: string) {
      return mapRefund(await call<Json>('GET', `/refunds/${encodeURIComponent(providerRefundId)}`));
    },

    verifyWebhook(rawBody: Buffer, signature: string) {
      return verifyHexHmac(opts.webhookSecret, rawBody, signature);
    },

    verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
      return verifyHexHmac(opts.keySecret, `${orderId}|${paymentId}`, signature);
    },

    parseWebhook(json: unknown): NormalizedEvent | null {
      return parseRazorpayWebhook(json);
    },
  };
}
