/**
 * System: duplicate and out-of-order payment webhooks.
 * Checkouts are paid only through hand-built, correctly signed mock provider webhooks (same shape and signing
 * as the demo path).
 *  1. The same captured event is delivered 5× concurrently, then re-delivered under new event ids, then a
 *     stale `payment.failed` and a late `payment.authorized` arrive -> exactly one APPLIED, the rest ignored;
 *     one set of PLACED child orders; one charge; no refund.
 *  2. A failed attempt arrives first and a successful retry on the same provider order later -> CAPTURED,
 *     child orders PLACED exactly once.
 */
import { expect, test } from '@playwright/test';
import { call, expectStable, getOrder, login, ok, placeOrder, waitFor, type Json, type PlacedOrder } from '../../fixtures/api.js';
import { RESTAURANTS, SIMPLE_ITEMS, runTag } from '../../fixtures/env.js';
import { paymentWebhookBody, postMockWebhook } from '../../fixtures/system.js';

const LINES = [
  { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
  { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
];

/** Placed exactly once: same children, one PLACED history entry each, stable over 3 samples. */
async function expectPlacedOnce(token: string, order: PlacedOrder): Promise<Json> {
  const placed = await waitFor('children PLACED', async () => {
    const o = await getOrder(token, order.checkoutId);
    return o.checkout.status === 'PAID_PLACED' && o.checkout.children.every((c: Json) => c.status === 'PLACED') ? o : null;
  });
  const ids = placed.checkout.children.map((c: Json) => c.id).sort();
  await expectStable(
    'children + PLACED entries',
    async () => {
      const o = await getOrder(token, order.checkoutId);
      return { status: o.checkout.status, ids: o.checkout.children.map((c: Json) => c.id).sort(), placed: o.checkout.children.map((c: Json) => c.statusHistory.filter((h: Json) => h.to === 'PLACED').length) };
    },
    { status: 'PAID_PLACED', ids, placed: ids.map(() => 1) },
  );
  return placed;
}

/** Restaurants decline the test order (refund path); responses checked. */
async function declineAll(order: PlacedOrder | null): Promise<void> {
  if (!order) return;
  for (const [user, rid] of [['owner1', RESTAURANTS.spiceRoute.id], ['owner2', RESTAURANTS.greenLeaf.id]] as const) {
    const child = order.checkout.children.find((c: Json) => c.restaurantId === rid);
    const now = child && (await getOrder((await login('consumer1')).token, order.checkoutId)).checkout.children.find((c: Json) => c.id === child.id);
    if (!now || now.status !== 'PLACED') continue;
    const r = await call('POST', `/owner/orders/${child.id}/reject`, { token: (await login(user)).token, body: { reason: 'e2e cleanup' } });
    expect(r.status, `cleanup reject ${child.code}: ${JSON.stringify(r.body)}`).toBe(200);
  }
}

test('replayed (5×) and out-of-order webhooks place the order once and charge once', async () => {
  const consumer = await login('consumer1');
  let order: PlacedOrder | null = null;
  try {
    order = await placeOrder(consumer.token, LINES, { pay: false });
    const { providerOrderId, amountPaise } = order.payment;
    expect(providerOrderId).toBeTruthy();
    const tag = runTag();
    const p = { id: `pay_e2e_${tag.replace(/-/g, '')}`, orderId: providerOrderId, amountPaise };

    // a forged signature is refused outright
    const capturedRaw = JSON.stringify(paymentWebhookBody('payment.captured', p));
    const forged = await postMockWebhook(capturedRaw, { eventId: `evt_${tag}_forged`, signature: 'deadbeef'.repeat(8) });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // the same signed captured event, 5× at once
    const eventId = `evt_${tag}_captured`;
    const burst = await Promise.all(Array.from({ length: 5 }, () => postMockWebhook(capturedRaw, { eventId })));
    for (const r of burst) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(burst.map((r) => r.body.result as string).sort()).toEqual(['APPLIED', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE']);

    // provider re-delivery of the same fact under a new event id, then out-of-order events
    expect((await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.captured', p)), { eventId: `evt_${tag}_captured_retry` })).body.result).toBe('IGNORED_STALE');
    const failedLate = await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.failed', { ...p, reason: 'late failure' })), { eventId: `evt_${tag}_failed` });
    expect(failedLate.status).toBe(200);
    expect(failedLate.body.result).toBe('IGNORED_STALE');
    expect((await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.authorized', p)), { eventId: `evt_${tag}_authorized` })).body.result).toBe('IGNORED_STALE');
    // no event id header: deduplicated by the body hash
    const noIdRaw = JSON.stringify(paymentWebhookBody('payment.failed', { ...p, reason: 'no id' }));
    expect((await postMockWebhook(noIdRaw)).body.result).toBe('IGNORED_STALE');
    expect((await postMockWebhook(noIdRaw)).body.result).toBe('IGNORED_DUPLICATE');

    // ---- outcome: one PLACED set, one charge
    const placed = await expectPlacedOnce(consumer.token, order);
    expect(placed.checkout.children).toHaveLength(2);
    const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment).toMatchObject({ status: 'CAPTURED', capturedPaise: amountPaise, refundedPaise: 0 });
    expect(placed.adjustedTotals).toMatchObject({ paidPaise: amountPaise, refundedPaise: 0, refundPendingPaise: 0 });
    for (const c of placed.checkout.children as Json[]) expect(c.refundStatus).toBe('NONE');
    const owner1 = await login('owner1');
    const list = ok(await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.spiceRoute.id}&status=PLACED&limit=100`, { token: owner1.token }), 'owner list');
    expect((list.items as Json[]).filter((x) => x.id === order!.child(RESTAURANTS.spiceRoute.id).id)).toHaveLength(1);
  } finally {
    await declineAll(order);
  }
});

test('failed attempt first, successful retry later on the same provider order -> captured, placed once', async () => {
  const consumer = await login('consumer1');
  let order: PlacedOrder | null = null;
  try {
    order = await placeOrder(consumer.token, LINES, { pay: false });
    const { providerOrderId, amountPaise } = order.payment;
    const tag = runTag();

    // attempt 1 fails (e.g. card declined)
    const fail = await postMockWebhook(
      JSON.stringify(paymentWebhookBody('payment.failed', { id: `pay_e2e_${tag.replace(/-/g, '')}a`, orderId: providerOrderId, amountPaise, reason: 'card declined' })),
      { eventId: `evt_${tag}_attempt1_failed` },
    );
    expect(fail.body.result).toBe('APPLIED');
    await waitFor('checkout shows the failed attempt', async () => {
      const v = ok(await call('GET', `/checkouts/${order!.checkoutId}`, { token: consumer.token }), 'GET checkout');
      return v.checkout.status === 'AWAITING_PAYMENT' && v.checkout.paymentStatus === 'FAILED' ? v : null;
    });

    // attempt 2 on the same provider order succeeds; its captured event is also delivered twice
    const captured = JSON.stringify(paymentWebhookBody('payment.captured', { id: `pay_e2e_${tag.replace(/-/g, '')}b`, orderId: providerOrderId, amountPaise }));
    const c1 = await postMockWebhook(captured, { eventId: `evt_${tag}_attempt2_captured` });
    const c2 = await postMockWebhook(captured, { eventId: `evt_${tag}_attempt2_captured` });
    expect(c1.body.result).toBe('APPLIED');
    expect(c2.body.result).toBe('IGNORED_DUPLICATE');

    await expectPlacedOnce(consumer.token, order);
    const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment).toMatchObject({ status: 'CAPTURED', capturedPaise: amountPaise, refundedPaise: 0 });
  } finally {
    await declineAll(order);
  }
});
