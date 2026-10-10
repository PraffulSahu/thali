/**
 * System: payment confirmed while the orders service is down.
 * Checkout created -> `docker compose stop orders` -> the provider confirms the payment (demo-pay success:
 * signed webhook -> payments outbox -> Redis stream) -> `docker compose start orders`. The orders consumer
 * must catch up from the stream and place the child orders within 60 s, exactly once.
 * The orders service is restarted in `finally` even if the test fails.
 */
import { expect, test } from '@playwright/test';
import { call, expectStable, getOrder, login, ok, placeOrder, waitFor, type Json, type PlacedOrder } from '../../fixtures/api.js';
import { RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { composePs } from '../../fixtures/stack.js';
import { startService, stopService, waitHealthy } from '../../fixtures/system.js';

test.setTimeout(300_000);

// belt and braces: never leave the stack with orders stopped
test.afterAll(async () => {
  if (composePs().find((c) => c.Service === 'orders')?.State !== 'running') await startService('orders');
  await waitHealthy('orders');
});

test('orders down during payment capture: PLACED within 60 s after restart, exactly once', async () => {
  const consumer = await login('consumer2');
  const owner1 = await login('owner1');
  const order: PlacedOrder = await placeOrder(
    consumer.token,
    [
      { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
      { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
    ],
    { pay: false },
  );
  await waitHealthy('orders');

  let restarted = false;
  try {
    stopService('orders');
    expect(composePs().find((c) => c.Service === 'orders')?.State).not.toBe('running');

    // orders is really unreachable now
    const down = await call('GET', `/checkouts/${order.checkoutId}`, { token: consumer.token });
    expect(down.status, JSON.stringify(down.body)).toBeGreaterThanOrEqual(502);

    // the provider confirms the payment; payments records it durably
    const paid = ok(await call('POST', `/demo-pay/${order.intentId}/complete`, { token: consumer.token, body: { outcome: 'success' } }), 'demo-pay complete');
    expect(paid.status).toBe('CAPTURED');

    await startService('orders');
    restarted = true;
    const t0 = Date.now();
    const placed = await waitFor('PAID_PLACED after orders restart', async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      return o.checkout.status === 'PAID_PLACED' && o.checkout.children.every((c: Json) => c.status === 'PLACED') ? o : null;
    }, { timeoutMs: 60_000, intervalMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(placed.checkout.paymentStatus).toBe('CAPTURED');

    // exactly once: same children with one PLACED entry each, stable over 3 samples after the catch-up
    const ids = placed.checkout.children.map((c: Json) => c.id).sort();
    await expectStable(
      'children + PLACED entries after recovery',
      async () => {
        const o = await getOrder(consumer.token, order.checkoutId);
        return { status: o.checkout.status, ids: o.checkout.children.map((c: Json) => c.id).sort(), placed: o.checkout.children.map((c: Json) => c.statusHistory.filter((h: Json) => h.to === 'PLACED').length) };
      },
      { status: 'PAID_PLACED', ids, placed: [1, 1] },
    );
    const spice = order.child(RESTAURANTS.spiceRoute.id);
    const board = ok(await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.spiceRoute.id}&status=PLACED&limit=100`, { token: owner1.token }), 'owner board');
    expect((board.items as Json[]).filter((x) => x.id === spice.id)).toHaveLength(1);
    const orders = ok(await call('GET', '/orders?limit=50', { token: consumer.token }), 'GET /orders').items as Json[];
    expect(orders.filter((o) => o.id === order.checkoutId)).toHaveLength(1);
    const payment = ok(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment).toMatchObject({ status: 'CAPTURED', capturedPaise: order.totalPaise, refundedPaise: 0 });
  } finally {
    if (!restarted) await startService('orders');
    // tidy: restaurants decline whatever was placed (refund path); responses checked
    const now = await getOrder(consumer.token, order.checkoutId).catch(() => null);
    for (const [user, rid] of [['owner1', RESTAURANTS.spiceRoute.id], ['owner2', RESTAURANTS.greenLeaf.id]] as const) {
      const c = now?.checkout.children.find((x: Json) => x.restaurantId === rid);
      if (c?.status !== 'PLACED') continue;
      const r = await call('POST', `/owner/orders/${c.id}/reject`, { token: (await login(user)).token, body: { reason: 'e2e cleanup' } });
      expect(r.status, `cleanup reject ${c.code}: ${JSON.stringify(r.body)}`).toBe(200);
    }
  }
});
