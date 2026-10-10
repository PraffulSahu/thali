/**
 * Flow 5: each restaurant sees and manages only its own child order.
 * One paid checkout with Spice Route + Green Leaf. Owner 1 (Spice Route) sees and accepts only the Spice
 * Route part on the live board; owner 2 (Green Leaf) sees only the Green Leaf part. Cross-restaurant reads and
 * actions are refused by the API and leave the other child untouched.
 */
import { expect, test } from '@playwright/test';
import { call, getChild, login, placeOrder, type Json } from '../fixtures/api.js';
import { PHONES, RESTAURANTS, SIMPLE_ITEMS } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { newRoleContext } from '../fixtures/ui.js';

test('restaurants see and manage only their own child order', async ({ browser }) => {
  const consumer = await login('consumer3');
  const order = await placeOrder(consumer.token, [
    { restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name },
    { restaurant: SIMPLE_ITEMS.dalMakhani.restaurant, name: SIMPLE_ITEMS.dalMakhani.name },
  ]);
  const spice = order.child(RESTAURANTS.spiceRoute.id);
  const green = order.child(RESTAURANTS.greenLeaf.id);

  const owner1 = await login('owner1');
  const owner2 = await login('owner2');

  // ---- API isolation
  const list1 = await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.spiceRoute.id}&status=PLACED&limit=100`, { token: owner1.token });
  expect(list1.status).toBe(200);
  const ids1 = (list1.body.items as Json[]).map((o) => o.id);
  expect(ids1).toContain(spice.id);
  expect(ids1).not.toContain(green.id);
  const listOther = await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.greenLeaf.id}`, { token: owner1.token });
  // either refused or scoped to the caller's own restaurants (empty) — never Green Leaf's orders
  expect([200, 403, 404], `owner1 listing Green Leaf: ${listOther.status}`).toContain(listOther.status);
  if (listOther.status === 200) expect(listOther.body.items).toEqual([]);
  const readOther = await call('GET', `/owner/orders/${green.id}`, { token: owner1.token });
  expect([403, 404]).toContain(readOther.status);
  expect(readOther.body.error.code).toMatch(/FORBIDDEN|NOT_FOUND/);
  const acceptOther = await call('POST', `/owner/orders/${green.id}/accept`, { token: owner1.token, body: { prepMinutes: 10 } });
  expect([403, 404]).toContain(acceptOther.status);
  const rejectOther = await call('POST', `/owner/orders/${spice.id}/reject`, { token: owner2.token, body: { reason: 'not mine' } });
  expect([403, 404]).toContain(rejectOther.status);
  expect((await getChild(consumer.token, order.checkoutId, green.id)).status).toBe('PLACED');
  expect((await getChild(consumer.token, order.checkoutId, spice.id)).status).toBe('PLACED');

  // ---- owner 1 UI: Spice Route board shows only the Spice Route part, accept it
  const o1 = await newRoleContext(browser);
  const o2 = await newRoleContext(browser);
  try {
    await signInViaPage(o1.page, PHONES.owner1, '/restaurant/orders');
    await o1.page.getByRole('combobox', { name: 'Restaurant' }).selectOption({ label: RESTAURANTS.spiceRoute.name });
    await expect(o1.page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
    await expect(o1.page.getByText(`Live orders for ${RESTAURANTS.spiceRoute.name}`)).toBeVisible();
    const card = o1.page.getByRole('listitem', { name: `Order ${spice.code}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText(SIMPLE_ITEMS.paneerTikka.name);
    await expect(o1.page.getByText(green.code)).toHaveCount(0);
    await expect(o1.page.getByRole('main')).not.toContainText(SIMPLE_ITEMS.dalMakhani.name);

    await card.getByRole('button', { name: 'Accept' }).click();
    const dialog = o1.page.getByRole('alertdialog', { name: `Accept order ${spice.code}?` });
    await dialog.getByRole('button', { name: 'Accept order' }).click();
    await expect(card.getByText('Accepted', { exact: true })).toBeVisible();
    await expect(card.getByRole('group', { name: 'Pickup code' })).toBeVisible();

    // ---- owner 2 UI: Green Leaf board shows only the Green Leaf part (still waiting)
    await signInViaPage(o2.page, PHONES.owner2, '/restaurant/orders');
    await o2.page.getByRole('combobox', { name: 'Restaurant' }).selectOption({ label: RESTAURANTS.greenLeaf.name });
    await expect(o2.page.getByText(`Live orders for ${RESTAURANTS.greenLeaf.name}`)).toBeVisible();
    const card2 = o2.page.getByRole('listitem', { name: `Order ${green.code}` });
    await expect(card2).toBeVisible();
    await expect(card2.getByText('Placed', { exact: true })).toBeVisible();
    await expect(card2.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(o2.page.getByText(spice.code)).toHaveCount(0);

    // ---- API: owner 1's action changed only the Spice Route part
    const s = await getChild(consumer.token, order.checkoutId, spice.id);
    const g = await getChild(consumer.token, order.checkoutId, green.id);
    expect(s.status).toBe('ACCEPTED');
    expect(g.status).toBe('PLACED');
    const own2 = await call('GET', `/owner/orders/${green.id}`, { token: owner2.token });
    expect(own2.status).toBe(200);
    expect(own2.body.status).toBe('PLACED');

    // tidy up: owner 2 declines its part (refund path is flow 8)
    await call('POST', `/owner/orders/${green.id}/reject`, { token: owner2.token, body: { reason: 'Kitchen is too busy' } });
  } finally {
    await o1.context.close();
    await o2.context.close();
  }
});
