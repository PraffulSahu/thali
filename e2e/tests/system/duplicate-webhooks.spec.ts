/**
 * System: duplicate and out-of-order payment webhooks.
 * A checkout is paid only through hand-built, correctly signed mock provider webhooks. The same captured event
 * is delivered 5× concurrently, then re-delivered under new event ids, then a stale `payment.failed` and a late
 * `payment.authorized` arrive. Expected: exactly one APPLIED, the rest ignored; one set of PLACED child
 * orders; one charge; no refund.
 */
import { expect, test } from '@playwright/test';
import { call, getOrder, login, ok, placeOrder, waitFor, type Json } from '../../fixtures/api.js';
import { RESTAURANTS, SIMPLE_ITEMS, runTag } from '../../fixtures/env.js';
import { paymentWebhookBody, postMockWebhook } from '../../fixtures/system.js';

test('replayed (5×) and out-of-order webhooks place the order once and charge once', async () => {
  const consumer = await login('consumer1');
  const order = await placeOrder(
    consumer.token,
    [
      { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
      { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
    ],
    { pay: false },
  );
  const { providerOrderId, amountPaise } = order.payment;
  expect(providerOrderId).toBeTruthy();
  const tag = runTag();
  const paymentId = `pay_e2e_${tag.replace(/-/g, '')}`;
  const p = { id: paymentId, orderId: providerOrderId, amountPaise };

  // a forged signature is refused outright
  const capturedRaw = JSON.stringify(paymentWebhookBody('payment.captured', p));
  const forged = await postMockWebhook(capturedRaw, { eventId: `evt_${tag}_forged`, signature: 'deadbeef'.repeat(8) });
  expect(forged.status).toBe(400);
  expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

  // the same signed captured event, 5× at once
  const eventId = `evt_${tag}_captured`;
  const burst = await Promise.all(Array.from({ length: 5 }, () => postMockWebhook(capturedRaw, { eventId })));
  for (const r of burst) expect(r.status, JSON.stringify(r.body)).toBe(200);
  const results = burst.map((r) => r.body.result as string).sort();
  expect(results).toEqual(['APPLIED', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE', 'IGNORED_DUPLICATE']);

  // provider re-delivery of the same fact under new event ids, then out-of-order events
  const again = await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.captured', p)), { eventId: `evt_${tag}_captured_retry` });
  expect(again.body.result).toBe('IGNORED_STALE');
  const failedLate = await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.failed', { ...p, reason: 'late failure' })), { eventId: `evt_${tag}_failed` });
  expect(failedLate.status).toBe(200);
  expect(failedLate.body.result).toBe('IGNORED_STALE');
  const authLate = await postMockWebhook(JSON.stringify(paymentWebhookBody('payment.authorized', p)), { eventId: `evt_${tag}_authorized` });
  expect(authLate.body.result).toBe('IGNORED_STALE');
  // no event id header: deduplicated by the body hash
  const noIdRaw = JSON.stringify(paymentWebhookBody('payment.failed', { ...p, reason: 'no id' }));
  const n1 = await postMockWebhook(noIdRaw);
  const n2 = await postMockWebhook(noIdRaw);
  expect(n1.body.result).toBe('IGNORED_STALE');
  expect(n2.body.result).toBe('IGNORED_DUPLICATE');

  // ---- outcome: one PLACED set, one charge
  const placed = await waitFor('children PLACED', async () => {
    const o = await getOrder(consumer.token, order.checkoutId);
    return o.checkout.children.every((c: Json) => c.status === 'PLACED') ? o : null;
  });
  expect(placed.checkout.status).toBe('PAID_PLACED');
  expect(placed.checkout.children).toHaveLength(2);
  await expect
    .poll(async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      return o.checkout.children.map((c: Json) => c.statusHistory.filter((h: Json) => h.to === 'PLACED').length);
    }, { intervals: [1000], timeout: 6000 })
    .toEqual([1, 1]);
  const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
  expect(payment).toMatchObject({ status: 'CAPTURED', capturedPaise: amountPaise, refundedPaise: 0 });
  expect(placed.adjustedTotals).toMatchObject({ paidPaise: amountPaise, refundedPaise: 0, refundPendingPaise: 0 });
  for (const c of placed.checkout.children as Json[]) expect(c.refundStatus).toBe('NONE');

  const owner1 = await login('owner1');
  const list = ok(await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.spiceRoute.id}&status=PLACED&limit=100`, { token: owner1.token }), 'owner list');
  const spiceChild = order.child(RESTAURANTS.spiceRoute.id);
  expect((list.items as Json[]).filter((x) => x.id === spiceChild.id)).toHaveLength(1);

  // tidy: restaurants decline (refund path)
  await call('POST', `/owner/orders/${spiceChild.id}/reject`, { token: owner1.token, body: { reason: 'e2e cleanup' } });
  const owner2 = await login('owner2');
  await call('POST', `/owner/orders/${order.child(RESTAURANTS.greenLeaf.id).id}/reject`, { token: owner2.token, body: { reason: 'e2e cleanup' } });
});
