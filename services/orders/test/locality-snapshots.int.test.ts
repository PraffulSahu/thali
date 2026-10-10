/**
 * Contract 4 (locality) + contract 2 (`order.accepted` fields): the identity address `locality` is
 * copied into the drop snapshot and the restaurant `address.locality` into the restaurant snapshot;
 * `order.accepted` carries the codes, `pickup.phone`, `drop.area` (locality → pincode) and `drop.label`.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import { applyCapturedPayment } from '../src/domain/place.js';
import { dropAreaOf } from '../src/domain/lifecycle.js';
import { asUser, DROP_ADDRESS, idemKey, outboxEvents, setup, type Harness } from './helpers.js';
import { asAdmin, asOwner, child } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('locality');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

const ADDRESS = { ...DROP_ADDRESS, label: 'Work', line1: '#402, 12th Main', landmark: 'near CMH Rd', locality: 'Indiranagar', pincode: '560038' };

async function placeOne(phone: string | null = '+918012345678') {
  const r = h.marketplace.addRestaurant({
    name: 'Green Leaf',
    address: { line1: '100 Feet Rd', locality: 'HAL 2nd Stage', city: 'Bengaluru', pincode: '560008' },
    ...(phone ? { phone } : {}),
  });
  if (!phone) (r as { phone: string | null }).phone = null;
  const item = h.marketplace.addItem(r.id, { name: 'Ghee Podi Masala Dosa', pricePaise: 18000 });
  const u = await asUser(h);
  h.identity.addUser(u.userId);
  expect((await u.post('/api/v1/cart/items', { restaurantId: r.id, itemId: item.id, quantity: 1 })).status).toBe(201);
  const c = await request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).set('Idempotency-Key', idemKey()).send({ address: ADDRESS });
  expect(c.status).toBe(201);
  await withTransaction(h.ctx.conn, (session) =>
    applyCapturedPayment(h.ctx, session, {
      checkoutId: c.body.checkout.id,
      paymentIntentId: c.body.payment.intentId,
      amountPaise: c.body.checkout.pricing.totalPaise,
      source: 'payment.captured',
    }),
  );
  return { r, u, checkout: c.body.checkout as { id: string; code: string; children: { id: string; code: string }[] } };
}

describe('locality snapshots', () => {
  it('copies address and restaurant locality into the child snapshots and views', async () => {
    const { checkout, u } = await placeOne();
    const kid = await child(h, checkout.children[0]!.id);
    expect(kid!.dropAddress).toMatchObject({ label: 'Work', locality: 'Indiranagar', pincode: '560038' });
    expect(kid!.restaurantAddress).toMatchObject({ line1: '100 Feet Rd', locality: 'HAL 2nd Stage' });
    expect(checkout).toMatchObject({ deliveryAddress: { locality: 'Indiranagar', label: 'Work' } });
    const detail = await u.get(`/api/v1/orders/${checkout.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.checkout.deliveryAddress.locality).toBe('Indiranagar');
    const adminView = await (await asAdmin(h)).get(`/api/v1/admin/orders/${checkout.id}`);
    expect(adminView.body.checkout.children[0].dropAddress.locality).toBe('Indiranagar');
  });

  it('a cart address carries locality too; legacy addresses without it view as null', async () => {
    const u = await asUser(h);
    const put = await u.put('/api/v1/cart/address', { address: ADDRESS });
    expect(put.status).toBe(200);
    expect(put.body.deliveryAddress.locality).toBe('Indiranagar');
    const v = await u.put('/api/v1/cart/address', { address: DROP_ADDRESS });
    expect(v.body.deliveryAddress.locality).toBeNull();
  });
});

describe('order.accepted (contract 2)', () => {
  it('carries childOrderCode, checkoutCode, pickup.phone, drop.area (locality) and drop.label', async () => {
    const { r, checkout } = await placeOne();
    const owner = await asOwner(h, r.ownerUserId);
    expect((await owner.post(`/api/v1/owner/orders/${checkout.children[0]!.id}/accept`, { prepMinutes: 15 })).status).toBe(200);
    const ev = (await outboxEvents(h, 'order.accepted')).find((e) => e.payload.childOrderId === checkout.children[0]!.id)!;
    expect(ev.payload).toMatchObject({
      childOrderCode: checkout.children[0]!.code,
      checkoutCode: checkout.code,
      pickup: { name: 'Green Leaf', phone: '+918012345678', address: '100 Feet Rd, Bengaluru, 560008' },
      drop: { area: 'Indiranagar', label: 'Work', address: '#402, 12th Main, near CMH Rd, Bengaluru, 560038', phoneMasked: '+91******3210' },
    });
  });

  it('omits pickup.phone when the restaurant has none; drop.area falls back to the pincode', () => {
    expect(dropAreaOf({ locality: '  ', pincode: '560038' })).toBe('560038');
    expect(dropAreaOf({ pincode: '560038' })).toBe('560038');
    expect(dropAreaOf({ locality: 'Koramangala', pincode: '560034' })).toBe('Koramangala');
  });

  it('pickup.phone absent when unknown', async () => {
    const { r, checkout } = await placeOne(null);
    const owner = await asOwner(h, r.ownerUserId);
    expect((await owner.post(`/api/v1/owner/orders/${checkout.children[0]!.id}/accept`, { prepMinutes: 15 })).status).toBe(200);
    const ev = (await outboxEvents(h, 'order.accepted')).find((e) => e.payload.childOrderId === checkout.children[0]!.id)!;
    expect('phone' in ev.payload.pickup).toBe(false);
  });

  it('GET /internal/orders/child/:id exposes the checkout code (delivery fallback)', async () => {
    const { checkout } = await placeOne();
    const r = await request(h.app)
      .get(`/internal/orders/child/${checkout.children[0]!.id}`)
      .set('authorization', `Bearer ${await h.internalToken('delivery')}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: checkout.children[0]!.code, checkoutCode: checkout.code });
  });
});
