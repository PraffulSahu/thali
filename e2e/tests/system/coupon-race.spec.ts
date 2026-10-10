/**
 * System: single-use coupon race.
 * A FLAT ₹100, min ₹399, platform-wide `totalLimit: 1` coupon is applied by three customers checking out
 * concurrently. Exactly one checkout gets the discount (the coupon is held for it), the other two are refused
 * with COUPON_LIMIT_REACHED, and the coupon counters show a single hold.
 *
 * Uses the seeded FLAT100 when it is still untouched (used 0 / held 0). Otherwise (the demo data was already
 * used by a run or a person) an identical fresh limit-1 coupon is created through the admin API.
 */
import { expect, test } from '@playwright/test';
import { addToCart, call, clearCart, findItem, login, ok, restaurantPage, type Json } from '../../fixtures/api.js';
import { adminToken } from '../../fixtures/admin.js';
import { SIMPLE_ITEMS, runTag } from '../../fixtures/env.js';
import { dropAddress, newKey } from '../../fixtures/system.js';

const BUYERS = ['consumer1', 'consumer2', 'consumer3'] as const;

test('3 parallel checkouts with a limit-1 coupon: exactly one gets it', async () => {
  const admin = await adminToken();
  const listCoupons = async (): Promise<Json[]> => {
    const r = ok(await call('GET', '/admin/marketplace/coupons', { token: admin }), 'admin coupons');
    return Array.isArray(r) ? r : r.items;
  };
  const flat100 = (await listCoupons()).find((c) => c.code === 'FLAT100');
  let coupon: Json;
  let created = false;
  if (flat100 && flat100.active && flat100.totalLimit === 1 && flat100.usedCount === 0 && flat100.heldCount === 0) {
    coupon = flat100;
  } else {
    const now = Date.now();
    coupon = ok(
      await call('POST', '/admin/marketplace/coupons', {
        token: admin,
        body: {
          code: `RACE${runTag().replace(/[^a-z0-9]/gi, '').toUpperCase()}`.slice(0, 30),
          description: 'e2e coupon-race: ₹100 off above ₹399, one redemption platform-wide',
          type: 'FLAT',
          valuePaise: 10000,
          minOrderPaise: 39900,
          validFrom: new Date(now - 60_000).toISOString(),
          validTo: new Date(now + 24 * 3600_000).toISOString(),
          totalLimit: 1,
          perUserLimit: 1,
        },
      }),
      'create limit-1 coupon',
    );
    created = true;
  }
  const code: string = coupon.code;

  const page = await restaurantPage(SIMPLE_ITEMS.paneerTikka.restaurant.slug);
  const itemId = findItem(page, SIMPLE_ITEMS.paneerTikka.name).id;
  const buyers = await Promise.all(BUYERS.map((u) => login(u)));
  for (const b of buyers) {
    await clearCart(b.token);
    await addToCart(b.token, SIMPLE_ITEMS.paneerTikka.restaurant.id, itemId, 2); // ₹458 ≥ ₹399
    const pv = ok(await call('POST', '/cart/preview', { token: b.token, body: { address: dropAddress('E2E coupon'), couponCode: code } }), 'preview');
    expect(pv.coupon?.valid, `${code} valid in preview: ${JSON.stringify(pv.coupon)}`).toBe(true);
  }

  try {
    const results = await Promise.all(
      buyers.map((b, i) =>
        call('POST', '/checkouts', { token: b.token, idempotencyKey: newKey(), body: { address: dropAddress(`E2E coupon ${i}`), couponCode: code, useMembership: false } }),
      ),
    );
    const summary = results.map((r) => `${r.status} ${r.body?.error?.code ?? r.body?.checkout?.couponCode}`).join(', ');
    const winners = results.filter((r) => r.status === 200 || r.status === 201);
    expect(winners.length, summary).toBe(1);
    expect(winners[0]!.body.checkout.couponCode).toBe(code);
    expect(winners[0]!.body.checkout.pricing.couponDiscountPaise).toBe(10000);
    for (const r of results.filter((x) => !winners.includes(x))) {
      expect(r.status, summary).toBe(422);
      expect(r.body.error.code).toMatch(/COUPON_LIMIT_REACHED|COUPON_INVALID/);
    }
    const c = (await listCoupons()).find((x) => x.code === code)!;
    expect(c.heldCount + c.usedCount, JSON.stringify(c)).toBe(1);
  } finally {
    for (const b of buyers) await clearCart(b.token);
    // a fresh race coupon must not stay usable in the demo
    if (created) {
      const r = await call('PATCH', `/admin/marketplace/coupons/${coupon.id}`, { token: await adminToken(), body: { active: false } });
      expect(r.status, `deactivate ${code}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.active).toBe(false);
    }
  }
});
