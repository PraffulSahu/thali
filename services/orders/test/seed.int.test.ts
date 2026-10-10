import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CHECKOUTS, demoOrderIds } from '@thali/contracts/seed-demo';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';
import { adjustedTotals } from '../src/domain/derive.js';
import { customerOrderDetail } from '../src/domain/order-views.js';
import { getModels, initOrdersDb, type CheckoutGroup, type ChildOrder } from '../src/models/index.js';
import { seedOrders, verifyDemoPricing } from '../src/seed.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('orders_seed');
  await initOrdersDb(db.conn);
});
afterAll(async () => {
  await db.drop();
});

describe('demo order fixture', () => {
  it('every breakdown equals @thali/pricing output (shared with the payments seed)', () => {
    for (const co of DEMO_CHECKOUTS) expect(() => verifyDemoPricing(co)).not.toThrow();
  });

  it('a drifted fixture is refused', () => {
    const co = structuredClone(DEMO_CHECKOUTS[0]!);
    co.children[0]!.breakdown.totalPaise += 1;
    expect(() => verifyDemoPricing(co)).toThrow(/drift/);
  });
});

describe('seedOrders', () => {
  it('seeds TH-DEMOMULTI (A delivered, B rejected + refund SUCCEEDED) and is idempotent', async () => {
    const first = await seedOrders(db.conn);
    expect(first.checkout_groups).toEqual({ inserted: 3, existing: 0 });
    expect(first.child_orders).toEqual({ inserted: 4, existing: 0 });
    expect(first.restaurant_projection).toEqual({ inserted: 4, existing: 0 });

    const { CheckoutGroup, ChildOrder } = getModels(db.conn);
    const multi = DEMO_CHECKOUTS.find((c) => c.code === 'TH-DEMOMULTI')!;
    const g = (await CheckoutGroup.findOne({ code: 'TH-DEMOMULTI' }).lean<CheckoutGroup>())!;
    const kids = await ChildOrder.find({ checkoutGroupId: g._id }).lean<ChildOrder[]>();
    expect(g.status).toBe('PARTIALLY_COMPLETED');
    expect(g.paymentIntentId).toBe(demoOrderIds.intent(multi));
    const a = kids.find((k) => k.code === 'TH-DEMOMULTI-A')!;
    const b = kids.find((k) => k.code === 'TH-DEMOMULTI-B')!;
    expect(a.status).toBe('DELIVERED');
    expect(a.deliveryJobId).toBe(demoOrderIds.job(multi, multi.children[0]!));
    expect(b).toMatchObject({ status: 'REJECTED', refundStatus: 'SUCCEEDED', refundedPaise: b.breakdown.totalPaise });
    expect(a.breakdown.totalPaise + b.breakdown.totalPaise).toBe(g.pricing.totalPaise);
    expect(adjustedTotals(g, kids)).toEqual({
      paidPaise: 109140,
      refundedPaise: 49530,
      refundPendingPaise: 0,
      netPaise: 59610,
    });
    // the customer view renders without errors and explains the rejection
    const view = customerOrderDetail(g, kids) as { explanations?: { kind: string }[] };
    expect(view.explanations?.map((e) => e.kind)).toEqual(['REJECTED']);

    const second = await seedOrders(db.conn);
    expect(Object.values(second).every((t) => t.inserted === 0)).toBe(true);
  });
});
