import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import { createEventHandlers } from '../src/events/handlers.js';
import { envelope, oid, setup, type Harness } from './helpers.js';

let h: Harness;
const ownerX = oid();
const ownerY = oid();
const restX = oid();
const restY = oid();
const partnerA = oid();
const partnerB = oid();

beforeAll(async () => {
  h = await setup('finance');
  h.marketplace.add(restX, ownerX);
  h.marketplace.add(restY, ownerY);
  const handlers = createEventHandlers(h.ctx);
  for (const [restaurantId, partnerUserId] of [
    [restX, partnerA],
    [restY, partnerB],
  ] as const) {
    const env = envelope('order.delivered', {
      childOrderId: oid(),
      checkoutId: oid(),
      userId: oid(),
      restaurantId,
      restaurantOwnerId: restaurantId === restX ? ownerX : ownerY,
      breakdown: {
        itemsSubtotalPaise: 10_000,
        couponDiscountPaise: 0,
        membershipDiscountPaise: 0,
        packagingFeePaise: 0,
        deliveryFeePaise: 0,
        deliveryDiscountPaise: 0,
        platformFeePaise: 0,
        foodTaxPaise: 0,
        feeTaxPaise: 0,
        totalPaise: 10_000,
      },
      commissionBps: 1000,
      deliveryJobId: oid(),
      partnerUserId,
      deliveryDistanceKm: 1,
    });
    await withTransaction(h.ctx.conn, (s) => handlers['order.delivered']!(env, s));
  }
});
afterAll(async () => {
  await h.cleanup();
});

const owner = (sub: string) => h.keys.sign({ sub, roles: ['CONSUMER', 'RESTAURANT_OWNER'] });
const partner = (sub: string) => h.keys.sign({ sub, roles: ['CONSUMER', 'DELIVERY_PARTNER'] });

describe('restaurant finance isolation', () => {
  it('owner of X can read X summary, ledger and payouts', async () => {
    const t = await owner(ownerX);
    const s = await request(h.app).get(`/api/v1/finance/restaurants/${restX}/summary`).set('authorization', `Bearer ${t}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ accountType: 'RESTAURANT', accountId: restX, balancePaise: 9_000, availablePaise: 9_000 });
    const l = await request(h.app).get(`/api/v1/finance/restaurants/${restX}/ledger?limit=1`).set('authorization', `Bearer ${t}`);
    expect(l.status).toBe(200);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.nextCursor).toBeTruthy();
    const l2 = await request(h.app).get(`/api/v1/finance/restaurants/${restX}/ledger?limit=5&cursor=${l.body.nextCursor}`).set('authorization', `Bearer ${t}`);
    expect(l2.body.items).toHaveLength(1);
    expect(l2.body.items[0].id).not.toBe(l.body.items[0].id);
    const p = await request(h.app).get(`/api/v1/finance/restaurants/${restX}/payouts`).set('authorization', `Bearer ${t}`);
    expect(p.status).toBe(200);
    expect(p.body.items).toEqual([]);
  });

  it('owner of restaurant X cannot read restaurant Y ledger (403), ownership via marketplace internal API', async () => {
    const t = await owner(ownerX);
    h.marketplace.calls = [];
    for (const part of ['summary', 'ledger', 'payouts']) {
      const res = await request(h.app).get(`/api/v1/finance/restaurants/${restY}/${part}`).set('authorization', `Bearer ${t}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(h.marketplace.calls).toContain(restY);
  });

  it('unknown restaurant → 404; non-owner role → 403; anonymous → 401', async () => {
    const t = await owner(ownerX);
    expect((await request(h.app).get(`/api/v1/finance/restaurants/${oid()}/summary`).set('authorization', `Bearer ${t}`)).status).toBe(404);
    const consumer = await h.keys.sign({ sub: ownerX, roles: ['CONSUMER'] });
    expect((await request(h.app).get(`/api/v1/finance/restaurants/${restX}/summary`).set('authorization', `Bearer ${consumer}`)).status).toBe(403);
    expect((await request(h.app).get(`/api/v1/finance/restaurants/${restX}/summary`)).status).toBe(401);
  });
});

describe('partner finance isolation', () => {
  it('partners only ever see their own account', async () => {
    const a = await partner(partnerA);
    const s = await request(h.app).get('/api/v1/finance/partner/summary').set('authorization', `Bearer ${a}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ accountType: 'PARTNER', accountId: partnerA, balancePaise: 3000 + 800 });
    const l = await request(h.app).get('/api/v1/finance/partner/ledger').set('authorization', `Bearer ${a}`);
    expect(l.body.items.every((e: { accountId: string }) => e.accountId === partnerA)).toBe(true);
    // query params cannot redirect to another account
    const sneaky = await request(h.app).get(`/api/v1/finance/partner/summary?accountId=${partnerB}`).set('authorization', `Bearer ${a}`);
    expect(sneaky.body.accountId).toBe(partnerA);
    const owner2 = await owner(ownerX);
    expect((await request(h.app).get('/api/v1/finance/partner/summary').set('authorization', `Bearer ${owner2}`)).status).toBe(403);
  });
});
