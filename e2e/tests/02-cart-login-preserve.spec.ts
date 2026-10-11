/**
 * Flow 2: a guest builds a multi-restaurant cart and signs in through phone verification without losing it.
 * UI: guest adds items from Spice Route and Green Leaf -> cart shows two restaurant groups (dock chips + cart page) ->
 * "Proceed to checkout" opens the OTP dialog -> checkout shows both. API: guest cart (X-Guest-Cart) before, user cart after.
 */
import { expect, test } from '@playwright/test';
import { call, clearCart, login, ok, type Json } from '../fixtures/api.js';
import { GEO, PHONES, RESTAURANTS, SIMPLE_ITEMS, formatINR } from '../fixtures/env.js';
import { fillOtpForm } from '../fixtures/otp.js';
import { chooseCurrentLocation, newRoleContext } from '../fixtures/ui.js';

test('guest multi-restaurant cart survives OTP sign-in', async ({ browser }) => {
  // the user's server cart starts empty so the merge result is exactly the guest cart
  const consumer = await login('consumer1');
  await clearCart(consumer.token);

  const { context, page } = await newRoleContext(browser, { geolocation: GEO.consumer1Home });
  try {
    await chooseCurrentLocation(page);

    // ---- guest adds from two restaurants
    await page.goto(`/restaurants/${RESTAURANTS.spiceRoute.slug}`);
    await page.getByRole('button', { name: `Add ${SIMPLE_ITEMS.paneerTikka.name}` }).click();
    await expect(page.getByText(`Added ${SIMPLE_ITEMS.paneerTikka.name} to ${RESTAURANTS.spiceRoute.name}`)).toBeVisible();

    await page.goto(`/restaurants/${RESTAURANTS.greenLeaf.slug}`);
    await page.getByRole('button', { name: `Add ${SIMPLE_ITEMS.dalMakhani.name}` }).click();
    await expect(page.getByText(`Added ${SIMPLE_ITEMS.dalMakhani.name} to ${RESTAURANTS.greenLeaf.name}`)).toBeVisible();
    // the floating multi-cart dock: one chip per restaurant cart
    const carts = page.getByRole('list', { name: 'Carts' });
    await expect(carts.getByRole('button', { name: new RegExp(RESTAURANTS.spiceRoute.name) })).toBeVisible();
    await expect(carts.getByRole('button', { name: new RegExp(RESTAURANTS.greenLeaf.name) })).toBeVisible();

    await page.goto('/cart');
    await expect(page.getByRole('region', { name: `From ${RESTAURANTS.spiceRoute.name}` })).toContainText(SIMPLE_ITEMS.paneerTikka.name);
    await expect(page.getByRole('region', { name: `From ${RESTAURANTS.greenLeaf.name}` })).toContainText(SIMPLE_ITEMS.dalMakhani.name);
    await expect(page.getByText('2 items from 2 restaurants')).toBeVisible();
    const subtotal = SIMPLE_ITEMS.paneerTikka.pricePaise + SIMPLE_ITEMS.dalMakhani.pricePaise;
    await expect(page.getByRole('complementary', { name: 'Cart summary' })).toContainText(formatINR(subtotal));

    // ---- API: the guest cart lives on the server under the guest token
    const guestToken = await page.evaluate(() => localStorage.getItem('thali.guestCart'));
    expect(guestToken, 'guest cart token in localStorage').toBeTruthy();
    const guestCart = ok(await call('GET', '/cart', { guest: guestToken! }), 'GET guest cart');
    expect(guestCart.ownerType).toBe('GUEST');
    expect(guestCart.restaurantCount).toBe(2);
    expect(guestCart.subtotalPaise).toBe(subtotal);

    // ---- sign in from the cart (dialog), lands on checkout
    // guests get the sign-in dialog from "Proceed to checkout" and then continue to checkout
    await page.getByRole('button', { name: 'Proceed to checkout' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in' });
    await fillOtpForm(dialog, PHONES.consumer1);
    await page.waitForURL('**/checkout');
    await expect(page.getByRole('heading', { name: /Two kitchens, one payment/, level: 1 })).toBeVisible();
    const review = page.getByRole('region', { name: 'Review items' });
    await expect(review.getByRole('region', { name: RESTAURANTS.spiceRoute.name })).toContainText(SIMPLE_ITEMS.paneerTikka.name);
    await expect(review.getByRole('region', { name: RESTAURANTS.greenLeaf.name })).toContainText(SIMPLE_ITEMS.dalMakhani.name);

    // cart page as the signed-in user still has both groups
    await page.goto('/cart');
    await expect(page.getByText('2 items from 2 restaurants')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Proceed to checkout' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('thali.guestCart')), 'guest token cleared after merge').toBeNull();

    // ---- API: the cart now belongs to the user, same lines
    const userCart = ok(await call('GET', '/cart', { token: consumer.token }), 'GET user cart');
    expect(userCart.ownerType).toBe('USER');
    expect(userCart.restaurantCount).toBe(2);
    expect(userCart.subtotalPaise).toBe(subtotal);
    const lines = (userCart.groups as Json[]).flatMap((g) => g.lines.map((l: Json) => `${g.restaurantName}:${l.name}x${l.quantity}`)).sort();
    expect(lines).toEqual([`${RESTAURANTS.greenLeaf.name}:${SIMPLE_ITEMS.dalMakhani.name}x1`, `${RESTAURANTS.spiceRoute.name}:${SIMPLE_ITEMS.paneerTikka.name}x1`]);
  } finally {
    await context.close();
    await clearCart(consumer.token).catch(() => undefined);
  }
});
