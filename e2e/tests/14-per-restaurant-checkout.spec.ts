/**
 * Per-restaurant checkout (ORD-3, board 10/12): a cart with two restaurants; "Checkout only Spice Route" from the
 * cart pays for that restaurant alone. The other restaurant's items stay in the cart, untouched, ready for a
 * second checkout. API: the checkout has exactly one child; the cart keeps the Green Leaf group.
 * I-1: the cart carries a coupon scoped to Green Leaf; the Spice Route checkout says it applies to Green Leaf, pays
 * without it (no 422) and leaves it on the cart for the Green Leaf order.
 */
import { expect, test } from '@playwright/test';
import { addToCart, call, clearCart, findItem, getOrder, login, ok, restaurantPage, waitFor, type Json } from '../fixtures/api.js';
import { adminToken } from '../fixtures/admin.js';
import { PHONES, RESTAURANTS, SIMPLE_ITEMS, formatINR } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { newRoleContext } from '../fixtures/ui.js';

test('checkout only one restaurant; the other stays in the cart', async ({ browser }) => {
  const consumer = await login('consumer3');
  await clearCart(consumer.token);
  for (const item of [SIMPLE_ITEMS.paneerTikka, SIMPLE_ITEMS.dalMakhani]) {
    const menu = await restaurantPage(item.restaurant.slug);
    await addToCart(consumer.token, item.restaurant.id, findItem(menu, item.name).id, 1);
  }
  // a Green Leaf-only coupon on the cart (as applied from Offers)
  const code = `GL${Date.now().toString(36).toUpperCase()}`.slice(0, 16);
  const now = Date.now();
  const created = await call('POST', '/admin/marketplace/coupons', {
    token: await adminToken(),
    body: { code, description: 'e2e Green Leaf only', type: 'FLAT', valuePaise: 5000, minOrderPaise: 0, validFrom: new Date(now - 60_000).toISOString(), validTo: new Date(now + 86_400_000).toISOString(), perUserLimit: 5, restaurantIds: [RESTAURANTS.greenLeaf.id], badgeLabel: '₹50 OFF' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  ok(await call('PUT', '/cart/coupon', { token: consumer.token, body: { couponCode: code } }), 'cart coupon');

  const { context, page } = await newRoleContext(browser);
  try {
    await signInViaPage(page, PHONES.consumer3, '/cart');
    await expect(page.getByText('2 items from 2 restaurants')).toBeVisible();
    await page
      .getByRole('region', { name: `From ${RESTAURANTS.spiceRoute.name}` })
      .getByRole('button', { name: `Checkout only ${RESTAURANTS.spiceRoute.name} →` })
      .click();
    await page.waitForURL(new RegExp(`/checkout\\?restaurant=${RESTAURANTS.spiceRoute.id}`));
    await expect(page.getByRole('heading', { name: /One kitchen, one payment/, level: 1 })).toBeVisible();
    const review = page.getByRole('region', { name: 'Review items' });
    await expect(review.getByRole('region', { name: RESTAURANTS.spiceRoute.name })).toContainText(SIMPLE_ITEMS.paneerTikka.name);
    await expect(review.getByRole('region', { name: RESTAURANTS.greenLeaf.name })).toHaveCount(0);
    await expect(page.getByText(`Applies to ${RESTAURANTS.greenLeaf.name} — not used on this checkout.`, { exact: false })).toBeVisible();

    // the preview for that subset = what the page asks to pay
    const address = (ok(await call('GET', '/me/addresses', { token: consumer.token }), 'addresses').items as Json[]).find((a) => a.isDefault) ?? null;
    expect(address, 'default address').toBeTruthy();
    const pay = page.getByRole('button', { name: /^Pay ₹/ }).first();
    await expect(pay).toBeEnabled();
    const label = (await pay.innerText()).trim();
    await pay.click();
    await page.waitForURL(/\/demo-pay\/[^/?]+/);
    const checkoutId = decodeURIComponent(new URL(page.url()).searchParams.get('return') ?? '').split('/').pop()!;
    await expect(page.getByRole('main')).toContainText(label.replace(/^Pay /, ''));
    await page.getByRole('button', { name: 'Simulate success' }).click();
    await page.waitForURL(`**/checkout/status/${checkoutId}`);
    await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('main')).toContainText(RESTAURANTS.spiceRoute.name);
    await expect(page.getByRole('main')).not.toContainText(RESTAURANTS.greenLeaf.name);

    // ---- API: one child, paid; the cart still holds the Green Leaf group only
    const placed = await waitFor('checkout PAID_PLACED', async () => {
      const o = await getOrder(consumer.token, checkoutId);
      return o.checkout.status === 'PAID_PLACED' ? o : null;
    });
    expect((placed.checkout.children as Json[]).map((c) => c.restaurantId)).toEqual([RESTAURANTS.spiceRoute.id]);
    expect(label).toBe(`Pay ${formatINR(placed.checkout.pricing.totalPaise)}`);
    const cart = ok(await call('GET', '/cart', { token: consumer.token }), 'GET cart');
    expect((cart.groups as Json[]).map((g) => g.restaurantId)).toEqual([RESTAURANTS.greenLeaf.id]);
    expect(cart.groups[0].lines.map((l: Json) => l.name)).toEqual([SIMPLE_ITEMS.dalMakhani.name]);
    expect(placed.checkout.couponCode).toBeNull();
    expect(cart.couponCode).toBe(code); // kept for the Green Leaf order

    // ---- UI: the cart page shows the remaining restaurant, ready for its own checkout
    await page.goto('/cart');
    await expect(page.getByText('1 item from 1 restaurant')).toBeVisible();
    await expect(page.getByRole('region', { name: `From ${RESTAURANTS.greenLeaf.name}` })).toContainText(SIMPLE_ITEMS.dalMakhani.name);
    await expect(page.getByRole('region', { name: `From ${RESTAURANTS.spiceRoute.name}` })).toHaveCount(0);

    // tidy: Spice Route rejects (refund path) so the board stays clean; empty the cart
    await call('POST', `/owner/orders/${placed.checkout.children[0].id}/reject`, { token: (await login('owner1')).token, body: { reason: 'e2e cleanup' } });
  } finally {
    await context.close();
    await clearCart(consumer.token).catch(() => undefined);
    await call('DELETE', `/admin/marketplace/coupons/${created.body.id}`, { token: await adminToken() }).catch(() => undefined);
  }
});
