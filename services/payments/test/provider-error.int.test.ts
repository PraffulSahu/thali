import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerLastErrors } from '@thali/service-kit';
import { setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('provider-error', { realProvider: true });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await h.cleanup();
});

describe('GW-1 provider error message', () => {
  it('records the scrubbed provider error message for razorpay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed for ops@example.com' } }), { status: 400 })),
    );
    await expect(h.provider.createOrder({ amountPaise: 100, currency: 'INR', receipt: 'r', notes: {} })).rejects.toThrow();
    await vi.waitFor(async () => {
      const errs = await providerLastErrors(h.ctx.redis, 'payments');
      expect(errs.razorpay?.message).toBe('Payment provider error: HTTP 400 BAD_REQUEST_ERROR: Authentication failed for [email]');
    });
  });
});
