/**
 * System: last-unit stock race.
 * The seeded tracked-stock item (Spice Route "Chef's Special Mutton Rogan Josh") is set to exactly one
 * available unit; five different customers check it out concurrently. Exactly one checkout may reserve it,
 * the other four get OUT_OF_STOCK, and the item ends with no free unit.
 */
import { expect, test } from '@playwright/test';
import { addToCart, call, clearCart, findItem, login, ok, restaurantPage, type Json } from '../../fixtures/api.js';
import { RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { dropAddress, newKey } from '../../fixtures/system.js';

const ITEM = "Chef's Special Mutton Rogan Josh";
const BUYERS = ['consumer1', 'consumer2', 'consumer3', 'partner2', 'owner2'] as const;

/**
 * Holds left by earlier runs (the winner's unpaid checkout is kept for retry until its TTL) would be superseded and
 * released synchronously by this run's checkout (I-2), freeing a second unit mid-race. Supersede them first with a
 * throwaway checkout of an untracked Spice Route item (no stock held), so exactly one unit is free for the race.
 */
async function supersedeLeftovers(token: string, i: number): Promise<void> {
  await clearCart(token);
  const it = findItem(await restaurantPage(SIMPLE_ITEMS.paneerTikka.restaurant.slug), SIMPLE_ITEMS.paneerTikka.name);
  await addToCart(token, SIMPLE_ITEMS.paneerTikka.restaurant.id, it.id, 1);
  ok(await call('POST', '/checkouts', { token, idempotencyKey: newKey(), body: { address: dropAddress(`E2E stock pre ${i}`), useMembership: false } }), 'throwaway checkout');
}

test('5 parallel checkouts for the last unit: exactly one succeeds', async () => {
  const owner1 = await login('owner1');
  const rid = RESTAURANTS.spiceRoute.id;
  const items = ok(await call('GET', `/owner/restaurants/${rid}/items`, { token: owner1.token }), 'owner items');
  const item = (Array.isArray(items) ? items : items.items as Json[]).find((i: Json) => i.name === ITEM);
  expect(item, `${ITEM} seeded`).toBeTruthy();
  expect(item.trackStock).toBe(true);
  const originalStock: number = item.stockQty;
  const itemId = findItem(await restaurantPage(RESTAURANTS.spiceRoute.slug), ITEM).id;

  const buyers = await Promise.all(BUYERS.map((u) => login(u)));
  try {
    for (const [i, b] of buyers.entries()) await supersedeLeftovers(b.token, i);
    // make sure the item can be added (at least one free unit), fill five carts, then leave exactly one unit
    ok(await call('PATCH', `/owner/restaurants/${rid}/items/${itemId}/availability`, { token: owner1.token, body: { available: true, stockQty: item.reservedQty + 5 } }), 'stock +5');
    for (const b of buyers) {
      await clearCart(b.token);
      await addToCart(b.token, rid, itemId, 1);
    }
    const fresh = ok(await call('GET', `/owner/restaurants/${rid}/items/${itemId}`, { token: owner1.token }), 'owner item');
    ok(await call('PATCH', `/owner/restaurants/${rid}/items/${itemId}/availability`, { token: owner1.token, body: { stockQty: fresh.reservedQty + 1 } }), 'stock = reserved + 1');
    const one = ok(await call('GET', `/owner/restaurants/${rid}/items/${itemId}`, { token: owner1.token }), 'owner item');
    expect(one.availableQty).toBe(1);

    const results = await Promise.all(
      buyers.map((b, i) =>
        call('POST', '/checkouts', { token: b.token, idempotencyKey: newKey(), body: { address: dropAddress(`E2E stock ${i}`), useMembership: false } }),
      ),
    );
    const summary = results.map((r) => `${r.status} ${r.body?.error?.code ?? r.body?.checkout?.status}`);
    const winners = results.filter((r) => r.status === 200 || r.status === 201);
    expect(winners.length, summary.join(', ')).toBe(1);
    // a loser fails either at reserve (409 OUT_OF_STOCK: lost the atomic hold) or, when its quote already sees the
    // winner's hold (e.g. it first superseded an older unpaid checkout of its own, I-2), at the quote (422
    // OUT_OF_STOCK problem) — never with a second reservation
    for (const r of results.filter((x) => !winners.includes(x))) {
      expect([409, 422], summary.join(', ')).toContain(r.status);
      expect(r.body.error.code).toBe('OUT_OF_STOCK');
    }
    expect(winners[0]!.body.checkout.status).toBe('AWAITING_PAYMENT');

    const after = ok(await call('GET', `/owner/restaurants/${rid}/items/${itemId}`, { token: owner1.token }), 'owner item after');
    expect(after.reservedQty).toBe(one.reservedQty + 1);
    expect(after.availableQty).toBe(0);
  } finally {
    for (const b of buyers) await clearCart(b.token);
    // restore the demo stock (the winner's unpaid hold is superseded by the next run, or expires with its checkout)
    const restore = await call('PATCH', `/owner/restaurants/${rid}/items/${itemId}/availability`, { token: owner1.token, body: { stockQty: Math.max(originalStock, 3) } });
    expect(restore.status, `stock restore: ${JSON.stringify(restore.body)}`).toBe(200);
    expect(restore.body.stockQty).toBe(Math.max(originalStock, 3));
  }
});
