/**
 * System: one checkout, two deliveries, different outcomes.
 * Spice Route + Green Leaf, both prepared. The partner delivers the Spice Route part; for the Green Leaf part
 * the partner picks it up and then reports a failed delivery. The parent stays IN_PROGRESS (DELIVERY_FAILED
 * awaits an admin decision), the admin cancels the failed part with a full refund, and the parent ends
 * PARTIALLY_COMPLETED with exactly that part refunded.
 */
import { expect, test } from '@playwright/test';
import { call, getOrder, login, ok, owner, placeOrder, waitFor, type Json } from '../../fixtures/api.js';
import { adminToken } from '../../fixtures/admin.js';
import { GEO, RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { adminCancelChild, partnerOnline, pingLocation, resetPartner, waitForOffer } from '../../fixtures/system.js';

test.setTimeout(420_000);

const NEAR = { lat: GEO.nearSpiceRoute.latitude, lng: GEO.nearSpiceRoute.longitude };

test('one part delivered, one failed -> IN_PROGRESS -> admin cancel + refund -> PARTIALLY_COMPLETED', async () => {
  const consumer = await login('consumer3');
  const p1 = await login('partner1');
  const owner1 = await login('owner1');
  const owner2 = await login('owner2');
  await resetPartner(p1.token);

  const order = await placeOrder(consumer.token, [
    { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
    { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
  ]);
  const spice = order.child(RESTAURANTS.spiceRoute.id);
  const green = order.child(RESTAURANTS.greenLeaf.id);
  const childNow = async (id: string) => (await getOrder(consumer.token, order.checkoutId)).checkout.children.find((c: Json) => c.id === id);

  try {
    await partnerOnline(p1.token, NEAR);
    const codes: Record<string, string> = {};
    for (const [tok, c] of [[owner1.token, spice], [owner2.token, green]] as const) {
      codes[c.id] = (await owner.accept(tok, c.id, 10)).pickupCode;
      await owner.preparing(tok, c.id);
      await owner.ready(tok, c.id);
    }

    // ---- Spice Route part: full delivery
    const o1 = await waitForOffer(p1.token, spice.id, NEAR, { keep: [green.id] });
    const job1 = ok(await call('POST', `/deliveries/offers/${o1.id}/accept`, { token: p1.token }), 'accept 1').job;
    ok(await call('POST', `/deliveries/${job1.id}/arrived`, { token: p1.token }), 'arrived 1');
    ok(await call('POST', `/deliveries/${job1.id}/pickup`, { token: p1.token, body: { code: codes[spice.id] } }), 'pickup 1');
    ok(await call('POST', `/deliveries/${job1.id}/start`, { token: p1.token }), 'start 1');
    const deliveryCode1 = (await childNow(spice.id)).deliveryCode;
    const d1 = ok(await call('POST', `/deliveries/${job1.id}/deliver`, { token: p1.token, body: { code: deliveryCode1 } }), 'deliver 1');
    expect(d1.status).toBe('DELIVERED');
    await waitFor('Spice Route part DELIVERED', async () => ((await childNow(spice.id)).status === 'DELIVERED' ? true : null));
    expect((await getOrder(consumer.token, order.checkoutId)).checkout.status).toBe('IN_PROGRESS');

    // ---- Green Leaf part: picked up, then the delivery fails
    const o2 = await waitForOffer(p1.token, green.id, NEAR);
    const job2 = ok(await call('POST', `/deliveries/offers/${o2.id}/accept`, { token: p1.token }), 'accept 2').job;
    ok(await call('POST', `/deliveries/${job2.id}/arrived`, { token: p1.token }), 'arrived 2');
    ok(await call('POST', `/deliveries/${job2.id}/pickup`, { token: p1.token, body: { code: codes[green.id] } }), 'pickup 2');
    await pingLocation(p1.token, { lat: NEAR.lat + 0.002, lng: NEAR.lng + 0.002 });
    const failed = ok(await call('POST', `/deliveries/${job2.id}/fail`, { token: p1.token, body: { reason: 'Customer unreachable at the door (e2e)' } }), 'fail 2');
    expect(failed.status).toBe('FAILED');

    const midway = await waitFor('Green Leaf part DELIVERY_FAILED', async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      return o.checkout.children.find((c: Json) => c.id === green.id).status === 'DELIVERY_FAILED' ? o : null;
    });
    expect(midway.checkout.status).toBe('IN_PROGRESS'); // DELIVERY_FAILED is not terminal: awaits admin
    expect(midway.checkout.children.find((c: Json) => c.id === spice.id).status).toBe('DELIVERED');
    expect((midway.explanations as Json[]).find((e) => e.childOrderId === green.id)?.kind).toBe('DELIVERY_FAILED');

    // ---- admin cancels the failed part with a full refund
    const admin = await adminToken();
    const greenTotal: number = green.breakdown.totalPaise;
    const tooMuch = await call('POST', `/admin/orders/child/${green.id}/cancel`, { token: admin, body: { reason: 'too much', refundPaise: order.totalPaise + 1 } });
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBeGreaterThanOrEqual(400);
    ok(await call('POST', `/admin/orders/child/${green.id}/cancel`, { token: admin, body: { reason: 'Delivery failed; refunding the customer (e2e)', refundPaise: greenTotal } }), 'admin cancel');

    const final = await waitFor('PARTIALLY_COMPLETED + refund SUCCEEDED', async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      const g = o.checkout.children.find((c: Json) => c.id === green.id);
      return o.checkout.status === 'PARTIALLY_COMPLETED' && g.status === 'CANCELLED' && g.refundStatus === 'SUCCEEDED' ? o : null;
    }, { timeoutMs: 120_000 });
    const g = final.checkout.children.find((c: Json) => c.id === green.id);
    const s = final.checkout.children.find((c: Json) => c.id === spice.id);
    expect(g.refundedPaise).toBe(greenTotal);
    expect(s.status).toBe('DELIVERED');
    expect(s.refundStatus).toBe('NONE');
    expect(final.adjustedTotals).toMatchObject({ paidPaise: order.totalPaise, refundedPaise: greenTotal, netPaise: order.totalPaise - greenTotal });
    const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedPaise: greenTotal });
    expect(await (async () => (ok(await call('GET', '/deliveries/active', { token: p1.token }), 'active').items as Json[]).length)()).toBe(0);
  } finally {
    // leave nothing in flight if the scenario aborted midway (best effort)
    for (const c of [spice, green]) {
      const now = await childNow(c.id).catch(() => null);
      if (now && ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERY_FAILED'].includes(now.status)) await adminCancelChild(c.id, c.breakdown.totalPaise).catch(() => undefined);
    }
    await call('POST', '/partner/offline', { token: p1.token }).catch(() => undefined);
  }
});
