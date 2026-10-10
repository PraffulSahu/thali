import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isDomainError } from '@thali/contracts';
import { createRazorpayProvider } from '../src/providers/razorpay.js';
import { PaymentProviderError } from '../src/providers/payment-provider.js';

const KEY_ID = 'rzp_test_abc';
const KEY_SECRET = 'secret_xyz';
const WH_SECRET = 'wh_secret_123';
const BASIC = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function make(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const fetchMock = vi.fn(fetchImpl);
  const sleep = vi.fn(extra.sleep ?? (async () => {}));
  const provider = createRazorpayProvider({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WH_SECRET,
    timeoutMs: extra.timeoutMs ?? 2000,
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
  });
  return { provider, fetchMock, sleep };
}

const call = (m: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = m.mock.calls[i] as [string, RequestInit];
  const headers = new Headers(init.headers);
  return { url, method: init.method, headers, body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal };
};

describe('razorpay provider: request shapes', () => {
  it('createOrder → POST /v1/orders with basic auth and {amount, currency, receipt, notes}', async () => {
    const { provider, fetchMock } = make(async () => jsonResponse(200, { id: 'order_123', entity: 'order', status: 'created' }));
    const res = await provider.createOrder({ amountPaise: 53_696, currency: 'INR', receipt: 'pi_abc', notes: { paymentIntentId: 'abc' } });
    expect(res).toEqual({ providerOrderId: 'order_123' });
    const c = call(fetchMock);
    expect(c.url).toBe('https://api.razorpay.com/v1/orders');
    expect(c.method).toBe('POST');
    expect(c.headers.get('authorization')).toBe(BASIC);
    expect(c.headers.get('content-type')).toBe('application/json');
    expect(c.body).toEqual({ amount: 53_696, currency: 'INR', receipt: 'pi_abc', notes: { paymentIntentId: 'abc' } });
    expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('fetchOrderPayments → GET /v1/orders/:id/payments mapped to ProviderPayment[]', async () => {
    const { provider, fetchMock } = make(async () =>
      jsonResponse(200, {
        entity: 'collection',
        count: 2,
        items: [
          { id: 'pay_1', entity: 'payment', amount: 500, currency: 'INR', status: 'failed', order_id: 'order_1', captured: false, created_at: 1700000000, error_description: 'declined' },
          { id: 'pay_2', entity: 'payment', amount: 500, currency: 'INR', status: 'captured', order_id: 'order_1', captured: true, created_at: 1700000100 },
        ],
      }),
    );
    const list = await provider.fetchOrderPayments('order_1');
    expect(call(fetchMock).url).toBe('https://api.razorpay.com/v1/orders/order_1/payments');
    expect(call(fetchMock).method).toBe('GET');
    expect(list).toEqual([
      { id: 'pay_1', orderId: 'order_1', amountPaise: 500, currency: 'INR', status: 'failed', captured: false, createdAt: new Date(1700000000_000), errorDescription: 'declined' },
      { id: 'pay_2', orderId: 'order_1', amountPaise: 500, currency: 'INR', status: 'captured', captured: true, createdAt: new Date(1700000100_000) },
    ]);
  });

  it('capture → POST /v1/payments/:id/capture {amount, currency}', async () => {
    const { provider, fetchMock } = make(async () =>
      jsonResponse(200, { id: 'pay_9', amount: 700, currency: 'INR', status: 'captured', order_id: 'order_9', captured: true, created_at: 1 }),
    );
    const p = await provider.capture('pay_9', 700);
    expect(call(fetchMock).url).toBe('https://api.razorpay.com/v1/payments/pay_9/capture');
    expect(call(fetchMock).body).toEqual({ amount: 700, currency: 'INR' });
    expect(p.status).toBe('captured');
  });

  it('refund → POST /v1/payments/:id/refund {amount, speed:normal, notes, receipt} + X-Refund-Idempotency header', async () => {
    const { provider, fetchMock } = make(async () => jsonResponse(200, { id: 'rfnd_1', entity: 'refund', amount: 5000, status: 'pending' }));
    const res = await provider.refund({ paymentId: 'pay_1', amountPaise: 5000, idempotencyKey: 'thali_abc_0', notes: { refundId: 'abc' } });
    expect(res).toEqual({ providerRefundId: 'rfnd_1', status: 'pending' });
    const c = call(fetchMock);
    expect(c.url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(c.method).toBe('POST');
    expect(c.headers.get('x-refund-idempotency')).toBe('thali_abc_0');
    expect(c.body).toEqual({ amount: 5000, speed: 'normal', notes: { refundId: 'abc' }, receipt: 'thali_abc_0' });
  });

  it('fetchRefund → GET /v1/refunds/:id', async () => {
    const { provider, fetchMock } = make(async () =>
      jsonResponse(200, { id: 'rfnd_1', payment_id: 'pay_1', amount: 5000, status: 'processed', notes: { refundId: 'x' }, receipt: 'r' }),
    );
    const r = await provider.fetchRefund('rfnd_1');
    expect(call(fetchMock).url).toBe('https://api.razorpay.com/v1/refunds/rfnd_1');
    expect(r).toEqual({ id: 'rfnd_1', paymentId: 'pay_1', amountPaise: 5000, status: 'processed', notes: { refundId: 'x' }, receipt: 'r' });
  });
});

describe('razorpay provider: failures', () => {
  it('timeout → PAYMENT_PROVIDER_UNAVAILABLE (retryable)', async () => {
    const { provider } = make(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      { timeoutMs: 30 },
    );
    const err = await provider.createOrder({ amountPaise: 1, currency: 'INR', receipt: 'r', notes: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(isDomainError(err) && err.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect((err as PaymentProviderError).httpStatus).toBe(502);
    expect((err as PaymentProviderError).retryable).toBe(true);
  });

  it('429 on an idempotent GET → waits Retry-After seconds and retries', async () => {
    let n = 0;
    const { provider, fetchMock, sleep } = make(async () => {
      n += 1;
      if (n === 1) return jsonResponse(429, { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } }, { 'retry-after': '2' });
      return jsonResponse(200, { entity: 'collection', count: 0, items: [] });
    });
    await expect(provider.fetchOrderPayments('order_x')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('429 on a POST is never retried', async () => {
    const { provider, fetchMock, sleep } = make(async () => jsonResponse(429, { error: { description: 'slow down' } }, { 'retry-after': '1' }));
    const err = await provider.refund({ paymentId: 'p', amountPaise: 1, idempotencyKey: 'thali_key_00', notes: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect((err as PaymentProviderError).retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('GET retries are bounded', async () => {
    const { provider, fetchMock } = make(async () => jsonResponse(429, {}, { 'retry-after': '1' }));
    await expect(provider.fetchRefund('rfnd_1')).rejects.toBeInstanceOf(PaymentProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('4xx → non-retryable PaymentProviderError with the provider error code, no secrets in the message', async () => {
    const { provider } = make(async () => jsonResponse(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be atleast INR 1.00' } }));
    const err = (await provider.createOrder({ amountPaise: 1, currency: 'INR', receipt: 'r', notes: {} }).catch((e: unknown) => e)) as PaymentProviderError;
    expect(err.retryable).toBe(false);
    expect(err.providerStatus).toBe(400);
    expect(err.providerCode).toBe('BAD_REQUEST_ERROR');
    expect(err.message).not.toContain(KEY_SECRET);
  });

  it('5xx → retryable', async () => {
    const { provider } = make(async () => jsonResponse(503, {}));
    const err = (await provider.capture('pay_1', 1).catch((e: unknown) => e)) as PaymentProviderError;
    expect(err.retryable).toBe(true);
  });
});

describe('razorpay provider: signatures and payload parsing', () => {
  const { provider } = make(async () => jsonResponse(200, {}));

  it('verifyWebhook = hex HMAC-SHA256 of the raw body with the webhook secret (constant-time)', () => {
    const raw = Buffer.from('{"a": 1}');
    const sig = createHmac('sha256', WH_SECRET).update(raw).digest('hex');
    expect(provider.verifyWebhook(raw, sig)).toBe(true);
    expect(provider.verifyWebhook(Buffer.from('{"a":1}'), sig)).toBe(false);
    expect(provider.verifyWebhook(raw, sig.slice(0, -2))).toBe(false);
    expect(provider.verifyWebhook(raw, 'zz'.repeat(32))).toBe(false);
    expect(provider.verifyWebhook(raw, '')).toBe(false);
  });

  it('verifyPaymentSignature = HMAC-SHA256(order_id|payment_id, key_secret)', () => {
    const sig = createHmac('sha256', KEY_SECRET).update('order_1|pay_1').digest('hex');
    expect(provider.verifyPaymentSignature('order_1', 'pay_1', sig)).toBe(true);
    expect(provider.verifyPaymentSignature('order_2', 'pay_1', sig)).toBe(false);
  });

  it('parseWebhook normalizes payment, order.paid and refund events; unknown → null', () => {
    const payment = provider.parseWebhook({
      event: 'payment.captured',
      created_at: 1700000000,
      payload: { payment: { entity: { id: 'pay_1', amount: 100, currency: 'INR', order_id: 'order_1', notes: { paymentIntentId: 'pi' } } } },
    });
    expect(payment).toEqual({
      type: 'payment.captured',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
      amountPaise: 100,
      currency: 'INR',
      createdAt: new Date(1700000000_000),
      notes: { paymentIntentId: 'pi' },
    });
    const failed = provider.parseWebhook({
      event: 'payment.failed',
      created_at: 1,
      payload: { payment: { entity: { id: 'pay_2', amount: 100, currency: 'INR', order_id: 'order_1', notes: [], error_description: 'declined' } } },
    });
    expect(failed).toMatchObject({ type: 'payment.failed', notes: {}, reason: 'declined' });
    const paid = provider.parseWebhook({
      event: 'order.paid',
      created_at: 1,
      payload: {
        order: { entity: { id: 'order_1', amount: 100, amount_paid: 100, currency: 'INR', receipt: 'rcpt', notes: { paymentIntentId: 'pi' } } },
        payment: { entity: { id: 'pay_3', amount: 100, currency: 'INR', order_id: 'order_1', notes: [] } },
      },
    });
    expect(paid).toMatchObject({ type: 'order.paid', providerOrderId: 'order_1', providerPaymentId: 'pay_3', amountPaise: 100, receipt: 'rcpt', notes: { paymentIntentId: 'pi' } });
    const refund = provider.parseWebhook({
      event: 'refund.processed',
      created_at: 1,
      payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 50, currency: 'INR', notes: { refundId: 'r1' } } } },
    });
    expect(refund).toMatchObject({ type: 'refund.processed', providerRefundId: 'rfnd_1', providerPaymentId: 'pay_1', amountPaise: 50, notes: { refundId: 'r1' } });
    expect(provider.parseWebhook({ event: 'payment.dispute.created', payload: {} })).toBeNull();
    expect(provider.parseWebhook('nope')).toBeNull();
  });
});
