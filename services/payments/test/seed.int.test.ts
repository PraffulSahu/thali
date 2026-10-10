import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedId } from '@thali/contracts/seed';
import { DEMO_CHECKOUTS, demoOrderIds } from '@thali/contracts/seed-demo';
import { accountSummary } from '../src/domain/ledger.js';
import { seedPayments } from '../src/seed.js';
import { setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('seed', { env: { PAYMENT_PROVIDER: 'mock', MOCK_WEBHOOK_SECRET: 'test-mock-webhook-secret-123' }, realProvider: true });
});
afterAll(async () => {
  await h.cleanup();
});

describe('seedPayments', () => {
  it('money records reconcile with the shared demo orders and the seed is idempotent', async () => {
    const first = await seedPayments(h.ctx.conn);
    expect(first.payment_intents).toEqual({ inserted: 3, existing: 0 });
    expect(first.refunds).toEqual({ inserted: 2, existing: 0 });
    expect(first.ledger_entries).toEqual({ inserted: 9, existing: 0 }); // 2 delivered children x 4 + 1 payout
    expect(first.payouts).toEqual({ inserted: 1, existing: 0 });

    const multi = DEMO_CHECKOUTS.find((c) => c.code === 'TH-DEMOMULTI')!;
    const [a, b] = multi.children;
    const intent = (await h.ctx.models.PaymentIntent.findById(demoOrderIds.intent(multi)).lean())!;
    expect(intent).toMatchObject({ status: 'PARTIALLY_REFUNDED', capturedPaise: multi.totals.totalPaise, refundedPaise: b!.breakdown.totalPaise, isDemo: true });
    const refund = (await h.ctx.models.Refund.findById(demoOrderIds.refund(multi, b!)).lean())!;
    expect(refund).toMatchObject({ status: 'SUCCEEDED', amountPaise: b!.breakdown.totalPaise, childOrderId: demoOrderIds.child(multi, b!), reason: 'RESTAURANT_REJECTED' });

    // A's ledger = what recordDeliveryEarnings posts: 51900 + 1500 earning, 20% commission, partner 3000 + 1 km x 800
    const entries = await h.ctx.models.LedgerEntry.find({ childOrderId: demoOrderIds.child(multi, a!) }).lean();
    const byKey = Object.fromEntries(entries.map((e) => [e.dedupeKey.split(':')[0], e.amountPaise]));
    expect(byKey).toEqual({ earning: 53400, commission: -10380, 'platform-commission': 10380, delivery: 3800 });

    const spice = await accountSummary(h.ctx, 'RESTAURANT', seedId('restaurant:spice-route'));
    expect(spice.balancePaise).toBe(53400 - 10380 - 20000); // TH-DEMOMULTI-A minus the recorded payout
    const partner1 = await accountSummary(h.ctx, 'PARTNER', seedId('user:partner1'));
    expect(partner1.balancePaise).toBe(3800);

    // the mock gateway knows the payment (so a later admin refund on a demo order works)
    const fetched = await h.ctx.provider.fetchOrderPayments(demoOrderIds.providerOrderId(multi));
    expect(fetched).toEqual([expect.objectContaining({ id: demoOrderIds.providerPaymentId(multi), captured: true, amountPaise: multi.totals.totalPaise })]);

    const second = await seedPayments(h.ctx.conn);
    expect(Object.values(second).every((t) => t.inserted === 0)).toBe(true);
  });
});
