/**
 * System: duplicate checkout submissions.
 * The same `POST /checkouts` with one Idempotency-Key fired 3× concurrently (double-click / network retry)
 * must create exactly one checkout: every successful response carries the same checkout and payment intent;
 * any other response may only be the documented "in progress" conflict. A later replay returns the same result.
 */
import { expect, test } from '@playwright/test';
import { addToCart, call, clearCart, defaultAddress, findItem, login, ok, restaurantPage, toAddressInput, type Json } from '../../fixtures/api.js';
import { SIMPLE_ITEMS } from '../../fixtures/env.js';
import { newKey } from '../../fixtures/system.js';

test('same Idempotency-Key ×3 in parallel creates one checkout', async () => {
  const consumer = await login('consumer3');
  await clearCart(consumer.token);
  const page = await restaurantPage(SIMPLE_ITEMS.paneerTikka.restaurant.slug);
  await addToCart(consumer.token, SIMPLE_ITEMS.paneerTikka.restaurant.id, findItem(page, SIMPLE_ITEMS.paneerTikka.name).id, 1);
  const address = toAddressInput(await defaultAddress(consumer.token));
  const preview = ok(await call('POST', '/cart/preview', { token: consumer.token, body: { address } }), 'preview');
  const body = { address, useMembership: false, expectedTotalPaise: preview.pricing.totalPaise };

  const listIds = async () => (ok(await call('GET', '/orders?limit=50', { token: consumer.token }), 'GET /orders').items as Json[]).map((o) => o.id as string);
  const before = new Set(await listIds());

  const key = newKey();
  const responses = await Promise.all([0, 1, 2].map(() => call('POST', '/checkouts', { token: consumer.token, idempotencyKey: key, body })));
  const okRes = responses.filter((r) => r.status === 200 || r.status === 201);
  const others = responses.filter((r) => !(r.status === 200 || r.status === 201));
  expect(okRes.length, responses.map((r) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).join('\n')).toBeGreaterThanOrEqual(1);
  for (const r of others) {
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toMatch(/IDEMPOTENCY_IN_PROGRESS|IDEMPOTENCY/);
  }
  const ids = new Set(okRes.map((r) => r.body.checkout.id as string));
  const intents = new Set(okRes.map((r) => r.body.payment?.intentId as string));
  expect(ids.size).toBe(1);
  expect(intents.size).toBe(1);
  const checkoutId = [...ids][0]!;

  // a replay after completion returns the stored result
  const replay = await call('POST', '/checkouts', { token: consumer.token, idempotencyKey: key, body });
  expect([200, 201]).toContain(replay.status);
  expect(replay.body.checkout.id).toBe(checkoutId);
  // a different key for the same unchanged cart also resolves to the active checkout (no second one)
  const otherKey = await call('POST', '/checkouts', { token: consumer.token, idempotencyKey: newKey(), body });
  expect([200, 201]).toContain(otherKey.status);
  expect(otherKey.body.checkout.id).toBe(checkoutId);

  const created = (await listIds()).filter((id) => !before.has(id));
  expect(created).toEqual([checkoutId]);
  const view = ok(await call('GET', `/checkouts/${checkoutId}`, { token: consumer.token }), 'GET checkout');
  expect(view.checkout.status).toBe('AWAITING_PAYMENT');
  expect(view.checkout.children).toHaveLength(1);
  // unpaid: it expires on its own (CHECKOUT_TTL_SEC) and releases its reservation
});
