import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import type { EventPayloads } from '@thali/contracts';
import { createIntent } from '../src/domain/intents.js';
import { accountSummary, deliveryEarningPaise, postEntry } from '../src/domain/ledger.js';
import { reconcileIntent } from '../src/domain/reconcile.js';
import { processDueRefunds } from '../src/domain/refunds.js';
import { createEventHandlers } from '../src/events/handlers.js';
import { adminToken, envelope, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('ledger');
});
afterAll(async () => {
  await h.cleanup();
});

function delivered(over: Partial<EventPayloads['order.delivered']> = {}): EventPayloads['order.delivered'] {
  return {
    childOrderId: oid(),
    checkoutId: oid(),
    userId: oid(),
    restaurantId: oid(),
    restaurantOwnerId: oid(),
    breakdown: {
      itemsSubtotalPaise: 53_000,
      couponDiscountPaise: 7_794,
      membershipDiscountPaise: 0,
      packagingFeePaise: 2_000,
      deliveryFeePaise: 3_000,
      deliveryDiscountPaise: 0,
      platformFeePaise: 500,
      foodTaxPaise: 2_360,
      feeTaxPaise: 630,
      totalPaise: 53_696,
    },
    commissionBps: 1800,
    deliveryJobId: oid(),
    partnerUserId: oid(),
    deliveryDistanceKm: 4.3,
    ...over,
  };
}

async function deliver(payload: EventPayloads['order.delivered']) {
  const handlers = createEventHandlers(h.ctx);
  const env = envelope('order.delivered', payload);
  await withTransaction(h.ctx.conn, (s) => handlers['order.delivered']!(env, s));
}

describe('ledger on order.delivered', () => {
  it('writes restaurant earning, commission, partner delivery earning exactly once (event delivered twice)', async () => {
    const p = delivered();
    await deliver(p);
    await deliver(p); // a second (re-published) event for the same child/job
    const entries = await h.ctx.models.LedgerEntry.find({ childOrderId: p.childOrderId }).lean();
    const byKey = Object.fromEntries(entries.map((e) => [e.dedupeKey, e]));
    expect(byKey[`earning:${p.childOrderId}`]).toMatchObject({
      accountType: 'RESTAURANT',
      accountId: p.restaurantId,
      entryType: 'ORDER_EARNING',
      amountPaise: 53_000 + 2_000, // ruling: discounts are platform-funded (not subtracted)
    });
    expect(byKey[`commission:${p.childOrderId}`]).toMatchObject({
      accountType: 'RESTAURANT',
      accountId: p.restaurantId,
      entryType: 'COMMISSION',
      amountPaise: -9_540, // bps(53000, 1800) = floor((53000*1800 + 5000)/10000)
    });
    const partner = await h.ctx.models.LedgerEntry.find({ dedupeKey: `delivery:${p.deliveryJobId}` }).lean();
    expect(partner).toHaveLength(1);
    expect(partner[0]).toMatchObject({
      accountType: 'PARTNER',
      accountId: p.partnerUserId,
      entryType: 'DELIVERY_EARNING',
      amountPaise: 3000 + 5 * 800,
      deliveryJobId: p.deliveryJobId,
    });
    const restaurantEntries = await h.ctx.models.LedgerEntry.countDocuments({ accountType: 'RESTAURANT', accountId: p.restaurantId });
    expect(restaurantEntries).toBe(2);
  });

  it('balances are computed from the ledger', async () => {
    const p = delivered();
    await deliver(p);
    await deliver(delivered({ restaurantId: p.restaurantId, partnerUserId: p.partnerUserId, deliveryDistanceKm: 2 }));
    const r = await accountSummary(h.ctx, 'RESTAURANT', p.restaurantId);
    expect(r).toMatchObject({
      accountType: 'RESTAURANT',
      accountId: p.restaurantId,
      balancePaise: 2 * (55_000 - 9_540),
      availablePaise: 2 * (55_000 - 9_540),
      pendingPayoutPaise: 0,
      paidOutPaise: 0,
    });
    expect(r.totalsByType).toMatchObject({ ORDER_EARNING: 2 * 55_000, COMMISSION: -2 * 9_540 });
    const partner = await accountSummary(h.ctx, 'PARTNER', p.partnerUserId);
    expect(partner.balancePaise).toBe(7000 + (3000 + 2 * 800));
  });

  it('the payout hold period excludes recent earnings from available', async () => {
    const p = delivered();
    await deliver(p);
    const cfg = h.ctx.config as { PAYOUT_HOLD_DAYS: number };
    cfg.PAYOUT_HOLD_DAYS = 2;
    try {
      const s = await accountSummary(h.ctx, 'RESTAURANT', p.restaurantId);
      expect(s.balancePaise).toBe(45_460);
      expect(s.availablePaise).toBe(0);
      h.clock.advance(2 * 86_400_000 + 1000);
      expect((await accountSummary(h.ctx, 'RESTAURANT', p.restaurantId)).availablePaise).toBe(45_460);
    } finally {
      cfg.PAYOUT_HOLD_DAYS = 0;
    }
  });

  it('with a hold period, negative entries apply immediately and available never exceeds balance − pending', async () => {
    const rid = oid();
    const post = (amountPaise: number, entryType: 'ORDER_EARNING' | 'REFUND_ADJUSTMENT') =>
      withTransaction(h.ctx.conn, (s) =>
        postEntry(h.ctx, s, {
          accountType: 'RESTAURANT',
          accountId: rid,
          entryType,
          amountPaise,
          dedupeKey: `t:${randomBytes(6).toString('hex')}`,
          memo: 't',
          createdBy: 'test',
        }),
      );
    await post(10_000, 'ORDER_EARNING'); // will be matured
    const cfg = h.ctx.config as { PAYOUT_HOLD_DAYS: number };
    cfg.PAYOUT_HOLD_DAYS = 2;
    try {
      h.clock.advance(3 * 86_400_000);
      await post(-6_000, 'REFUND_ADJUSTMENT'); // fresh negative: applies immediately
      await post(5_000, 'ORDER_EARNING'); // fresh positive: held
      let s = await accountSummary(h.ctx, 'RESTAURANT', rid);
      expect(s.balancePaise).toBe(9_000);
      expect(s.availablePaise).toBe(4_000);
      await post(-12_000, 'REFUND_ADJUSTMENT'); // balance goes negative → available floors at 0
      s = await accountSummary(h.ctx, 'RESTAURANT', rid);
      expect(s.balancePaise).toBe(-3_000);
      expect(s.availablePaise).toBe(0);
      h.clock.advance(3 * 86_400_000);
      expect((await accountSummary(h.ctx, 'RESTAURANT', rid)).availablePaise).toBe(0);
    } finally {
      cfg.PAYOUT_HOLD_DAYS = 0;
    }
  });

  it('missing deliveryDistanceKm → base rate only + LEDGER_DISTANCE_MISSING alert', async () => {
    const p = delivered({ deliveryDistanceKm: undefined as unknown as number });
    await deliver(p);
    const [e] = await h.ctx.models.LedgerEntry.find({ dedupeKey: `delivery:${p.deliveryJobId}` }).lean();
    expect(e!.amountPaise).toBe(3000);
    expect(h.logs.some((l) => l.alert === 'LEDGER_DISTANCE_MISSING' && l.childOrderId === p.childOrderId)).toBe(true);
  });

  it('delivery earning uses integer ceil of the distance with float noise removed', () => {
    expect(deliveryEarningPaise(4.3, 3000, 800)).toBe(3000 + 5 * 800);
    expect(deliveryEarningPaise(4, 3000, 800)).toBe(3000 + 4 * 800);
    expect(deliveryEarningPaise(4.0000001, 3000, 800)).toBe(3000 + 4 * 800);
    expect(deliveryEarningPaise(4.3 - 2.3, 3000, 800)).toBe(3000 + 2 * 800);
    expect(deliveryEarningPaise(0, 3000, 800)).toBe(3000);
  });

  it('admin refund after delivery with chargeRestaurantPaise records a REFUND_ADJUSTMENT once the refund succeeds', async () => {
    const p = delivered();
    await deliver(p);
    const { intent } = await createIntent(h.ctx, { purpose: 'CHECKOUT', referenceId: p.checkoutId, userId: p.userId, amountPaise: 53_696 });
    h.fake.addPayment(intent.providerOrderId!, { status: 'captured', amountPaise: 53_696 });
    await reconcileIntent(h.ctx, intent.id);
    const token = await adminToken(h.keys);
    const res = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({
        paymentIntentId: intent.id,
        childOrderId: p.childOrderId,
        restaurantId: p.restaurantId,
        amountPaise: 10_000,
        chargeRestaurantPaise: 6_000,
        note: 'cold food',
      });
    expect(res.status).toBe(201);
    expect(await h.ctx.models.LedgerEntry.countDocuments({ entryType: 'REFUND_ADJUSTMENT', accountId: p.restaurantId })).toBe(0);
    h.fake.refund.mockImplementationOnce(async () => ({ providerRefundId: 'rfnd_adj', status: 'processed' as const }));
    await processDueRefunds(h.ctx);
    const adj = await h.ctx.models.LedgerEntry.find({ entryType: 'REFUND_ADJUSTMENT', accountId: p.restaurantId }).lean();
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ accountType: 'RESTAURANT', amountPaise: -6_000, childOrderId: p.childOrderId });
    const bad = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({ paymentIntentId: intent.id, amountPaise: 100, chargeRestaurantPaise: 200, restaurantId: p.restaurantId, note: 'x' });
    expect(bad.status).toBe(400);
  });

  it('GET /admin/finance/balances?accountType lists account balances', async () => {
    const p = delivered();
    await deliver(p);
    const token = await adminToken(h.keys, { adm: ['SUPER_ADMIN'] });
    const res = await request(h.app).get('/api/v1/admin/finance/balances?accountType=PARTNER').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((x: { accountId: string }) => x.accountId === p.partnerUserId);
    expect(row).toMatchObject({ accountType: 'PARTNER', balancePaise: 7000, availablePaise: 7000 });
  });
});
