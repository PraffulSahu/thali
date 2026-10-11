/**
 * Flow 3: checkout calculates correct server-side totals and initiates payment.
 * Flow 4: verified payment confirmation places the correct child orders exactly once.
 *
 * Totals are re-derived here from first principles (menu prices, seeded service-area fee rule, .env tax/fee
 * config) and compared with the server preview, the checkout UI and the created checkout. Payment goes
 * through the labeled demo payment page; the order is "placed" only once the server says so.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addToCart, call, clearCart, defaultAddress, expectStable, findItem, getOrder, login, ok, restaurantPage, toAddressInput, waitFor, type Json } from '../fixtures/api.js';
import { RESTAURANTS, SIMPLE_ITEMS, formatINR, PHONES } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { newRoleContext } from '../fixtures/ui.js';

/** Seeded service area "Bengaluru — Koramangala & HSR (demo)": ₹25 for 2 km, +₹8/km (started), max ₹80. */
const FEE_RULE = { basePaise: 2500, baseKm: 2, perKmPaise: 800, maxPaise: 8000 };
/** .env.example: FOOD_TAX_BPS=500, FEE_TAX_BPS=1800, PLATFORM_FEE_PAISE=500 (per child order). */
const FOOD_TAX_BPS = 500;
const FEE_TAX_BPS = 1800;
const PLATFORM_FEE_PAISE = 500;

const bps = (amount: number, rate: number) => Math.floor((amount * rate + 5000) / 10000); // round half up
const fee = (km: number) => Math.min(FEE_RULE.maxPaise, FEE_RULE.basePaise + Math.max(0, Math.ceil(km - FEE_RULE.baseKm)) * FEE_RULE.perKmPaise);
const FIELDS = [
  'itemsSubtotalPaise', 'couponDiscountPaise', 'membershipDiscountPaise', 'packagingFeePaise', 'deliveryFeePaise',
  'deliveryDiscountPaise', 'platformFeePaise', 'foodTaxPaise', 'feeTaxPaise', 'totalPaise',
] as const;

test('server-side totals, demo payment, child orders placed exactly once', async ({ browser }) => {
  const consumer = await login('consumer2');
  const lines = [
    { item: SIMPLE_ITEMS.paneerTikka, qty: 2 },
    { item: SIMPLE_ITEMS.dalMakhani, qty: 1 },
  ];

  // ---- cart (API; flow 2 covers adding from the UI)
  await clearCart(consumer.token);
  const pages = new Map<string, Json>();
  for (const l of lines) {
    const page = pages.get(l.item.restaurant.id) ?? (await restaurantPage(l.item.restaurant.slug));
    pages.set(l.item.restaurant.id, page);
    await addToCart(consumer.token, l.item.restaurant.id, findItem(page, l.item.name).id, l.qty);
  }
  const address = toAddressInput(await defaultAddress(consumer.token));

  // ---- flow 3: the server preview equals an independent computation
  const preview = ok(await call('POST', '/cart/preview', { token: consumer.token, body: { address } }), 'POST /cart/preview');
  expect(preview.canCheckout, JSON.stringify(preview.problems)).toBe(true);
  expect(preview.children).toHaveLength(2);
  for (const child of preview.children as Json[]) {
    const page = pages.get(child.restaurantId)!;
    const mine = lines.filter((l) => l.item.restaurant.id === child.restaurantId);
    const items = mine.reduce((s, l) => s + findItem(page, l.item.name).pricePaise * l.qty, 0);
    const b = child.breakdown;
    expect(b.itemsSubtotalPaise, `${child.restaurantName} items`).toBe(items);
    expect(b.couponDiscountPaise + b.membershipDiscountPaise + b.deliveryDiscountPaise).toBe(0);
    expect(b.packagingFeePaise, `${child.restaurantName} packaging`).toBe(page.restaurant.packagingFeePaise);
    expect(b.platformFeePaise).toBe(PLATFORM_FEE_PAISE);
    // distanceKm is rounded for display; accept the fee for any distance within ±0.05 km of it
    const fees = new Set([fee(Math.max(0, child.distanceKm - 0.05)), fee(child.distanceKm), fee(child.distanceKm + 0.05)]);
    expect([...fees], `${child.restaurantName} delivery fee for ${child.distanceKm} km`).toContain(b.deliveryFeePaise);
    expect(b.foodTaxPaise).toBe(bps(items + b.packagingFeePaise, FOOD_TAX_BPS));
    expect(b.feeTaxPaise).toBe(bps(b.deliveryFeePaise + b.platformFeePaise, FEE_TAX_BPS));
    expect(b.totalPaise).toBe(items + b.packagingFeePaise + b.deliveryFeePaise + b.platformFeePaise + b.foodTaxPaise + b.feeTaxPaise);
    for (const l of child.lines as Json[]) expect(l.lineTotalPaise).toBe(l.unitPricePaise * l.quantity);
  }
  for (const f of FIELDS) {
    expect(preview.pricing[f], `checkout ${f} = Σ children`).toBe((preview.children as Json[]).reduce((s, c) => s + c.breakdown[f], 0));
  }
  const total: number = preview.pricing.totalPaise;

  // a stale client total is refused (server is the authority) and nothing is created
  const stale = await call('POST', '/checkouts', { token: consumer.token, idempotencyKey: randomUUID(), body: { address, useMembership: false, expectedTotalPaise: total - 100 } });
  expect(stale.status, JSON.stringify(stale.body)).toBe(422); // LLD: 422 PRICE_CHANGED with the new breakdown
  expect(stale.body.error.code).toBe('PRICE_CHANGED');
  expect(stale.body.error.details.pricing.totalPaise).toBe(total);

  // ---- UI: checkout page shows the same totals and starts the payment
  const { context, page } = await newRoleContext(browser);
  try {
    await signInViaPage(page, PHONES.consumer2, '/checkout');
    await expect(page.getByRole('heading', { name: /Two kitchens, one payment/, level: 1 })).toBeVisible();
    const bill = page.getByRole('complementary', { name: 'Bill, per restaurant' });
    await expect(bill).toContainText(formatINR(total));
    for (const child of preview.children as Json[]) {
      // one collapsible row per restaurant with its own total; the first one starts expanded with its rows
      await expect(bill.getByRole('button', { name: new RegExp(child.restaurantName) })).toContainText(formatINR(child.breakdown.totalPaise));
    }
    const first = (preview.children as Json[])[0];
    await expect(bill).toContainText(formatINR(first.breakdown.itemsSubtotalPaise));
    await expect(bill).toContainText(formatINR(first.breakdown.deliveryFeePaise));
    const pay = page.getByRole('button', { name: `Pay ${formatINR(total)}` });
    await expect(pay).toBeEnabled();
    await pay.click();

    // demo payment page (labelled), amount = server total
    await page.waitForURL(/\/demo-pay\/[^/?]+/);
    const url = new URL(page.url());
    const intentId = url.pathname.split('/').pop()!;
    const checkoutId = decodeURIComponent(url.searchParams.get('return') ?? '').split('/').pop()!;
    expect(checkoutId).toMatch(/^[a-f0-9]{24}$/);
    await expect(page.getByText('DEMO PAYMENT — no real money')).toBeVisible();
    await expect(page.getByRole('main')).toContainText(formatINR(total));

    // API: checkout exists, unpaid, totals identical to the preview
    const pending = ok(await call('GET', `/checkouts/${checkoutId}`, { token: consumer.token }), 'GET checkout (pending)');
    expect(pending.checkout.status).toBe('AWAITING_PAYMENT');
    expect(pending.checkout.pricing).toEqual(preview.pricing);
    expect(pending.payment.intentId).toBe(intentId);
    expect(pending.payment.amountPaise).toBe(total);
    expect((pending.checkout.children as Json[]).map((c) => c.status)).toEqual(['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);

    // ---- flow 4: simulate provider success -> server confirms -> "Order placed"
    await page.getByRole('button', { name: 'Simulate success' }).click();
    await page.waitForURL(`**/checkout/status/${checkoutId}`);
    await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible({ timeout: 60_000 });
    for (const r of [RESTAURANTS.spiceRoute.name, RESTAURANTS.greenLeaf.name]) await expect(page.getByRole('main')).toContainText(r);

    const placed = await waitFor('checkout PAID_PLACED with 2 PLACED children', async () => {
      const o = await getOrder(consumer.token, checkoutId);
      return o.checkout.status === 'PAID_PLACED' && o.checkout.children.every((c: Json) => c.status === 'PLACED') ? o : null;
    });
    expect(placed.checkout.children).toHaveLength(2);
    expect(placed.checkout.paymentStatus).toBe('CAPTURED');
    expect(placed.adjustedTotals.paidPaise).toBe(total);
    for (const pc of preview.children as Json[]) {
      const child = placed.checkout.children.find((c: Json) => c.restaurantId === pc.restaurantId);
      expect(child.breakdown, `${pc.restaurantName} child breakdown`).toEqual(pc.breakdown);
      expect(child.statusHistory.filter((h: Json) => h.to === 'PLACED')).toHaveLength(1);
    }

    // a repeated provider confirmation is refused and changes nothing
    const replay = await call('POST', `/demo-pay/${intentId}/complete`, { token: consumer.token, body: { outcome: 'success' } });
    expect(replay.status).toBe(409);
    const payment = ok(await call('GET', `/payments/checkout/${checkoutId}`, { token: consumer.token }), 'GET payment');
    expect(payment.status).toBe('CAPTURED');
    expect(payment.capturedPaise).toBe(total);
    // stable over several seconds: same two children, one PLACED entry each (no duplicate event applied late)
    const childIds = placed.checkout.children.map((c: Json) => c.id).sort();
    const snapshot = async () => {
      const o = await getOrder(consumer.token, checkoutId);
      return {
        ids: o.checkout.children.map((c: Json) => c.id).sort(),
        placedEntries: o.checkout.children.map((c: Json) => c.statusHistory.filter((h: Json) => h.to === 'PLACED').length),
      };
    };
    await expectStable('children + PLACED entries', snapshot, { ids: childIds, placedEntries: [1, 1] }, { samples: 3, intervalMs: 1000 });
    const orders = ok(await call('GET', '/orders?limit=50', { token: consumer.token }), 'GET /orders').items as Json[];
    expect(orders.filter((o) => o.id === checkoutId)).toHaveLength(1);

    // each restaurant sees exactly one child order for this checkout
    for (const [user, rid] of [['owner1', RESTAURANTS.spiceRoute.id], ['owner2', RESTAURANTS.greenLeaf.id]] as const) {
      const ownerTok = (await login(user)).token;
      const list = ok(await call('GET', `/owner/orders?restaurantId=${rid}&status=PLACED&limit=100`, { token: ownerTok }), `owner orders ${rid}`);
      const mine = (list.items as Json[]).filter((o) => placed.checkout.children.some((c: Json) => c.id === o.id));
      expect(mine, `${user} sees one child order`).toHaveLength(1);
    }

    // cart emptied by the placement, order visible once in "Orders"
    const cart = ok(await call('GET', '/cart', { token: consumer.token }), 'GET cart');
    expect(cart.groups).toHaveLength(0);
    await page.getByRole('link', { name: 'Track order' }).click();
    await expect(page.getByRole('heading', { name: placed.checkout.code, level: 1 })).toBeVisible();
    await page.goto('/orders');
    await expect(page.getByRole('link', { name: new RegExp(placed.checkout.code) })).toHaveCount(1);
  } finally {
    await context.close();
  }
});
