/**
 * Flow 10: unauthorized access and invalid state transitions are rejected.
 * API: no token / forged token -> 401, wrong role -> 403, another user's or another restaurant's resources ->
 * 403/404, out-of-order lifecycle actions -> 409, all with the standard error envelope and no state change.
 * UI: guests get the sign-in prompt, a consumer gets the "no access" state in the restaurant, partner and
 * admin areas.
 */
import { expect, test } from '@playwright/test';
import { call, getChild, login, owner, placeOrder, type ApiRes } from '../fixtures/api.js';
import { PHONES, RESTAURANTS, SIMPLE_ITEMS } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { newRoleContext } from '../fixtures/ui.js';

function expectError(r: ApiRes, statuses: number[], code?: RegExp) {
  expect(statuses, `HTTP ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
  expect(r.body?.error?.code, JSON.stringify(r.body)).toEqual(expect.any(String));
  expect(r.body.error.message).toEqual(expect.any(String));
  expect(r.body.error.requestId).toEqual(expect.any(String));
  if (code) expect(r.body.error.code).toMatch(code);
}

test('API rejects unauthenticated, unauthorized and out-of-order requests', async () => {
  const consumer3 = await login('consumer3');
  const consumer1 = await login('consumer1');
  const owner1 = await login('owner1');
  const owner2 = await login('owner2');
  const order = await placeOrder(consumer3.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }]);
  const child = order.child(RESTAURANTS.spiceRoute.id);

  // ---- 401: no token / forged token
  for (const path of ['/orders', '/me', '/owner/orders', '/partner/offers', '/admin/orders', `/orders/${order.checkoutId}`]) {
    expectError(await call('GET', path), [401], /UNAUTHENTICATED/);
  }
  const [h, p] = consumer3.token.split('.');
  const forged = `${h}.${p}.${'A'.repeat(43)}`;
  expectError(await call('GET', '/me', { token: forged }), [401], /UNAUTHENTICATED/);
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), roles: ['ADMIN'] })).toString('base64url')}.${consumer3.token.split('.')[2]}`;
  expectError(await call('GET', '/admin/orders', { token: tampered }), [401], /UNAUTHENTICATED/);

  // ---- 403: wrong role
  expectError(await call('GET', `/owner/orders?restaurantId=${RESTAURANTS.spiceRoute.id}`, { token: consumer3.token }), [403], /FORBIDDEN/);
  // partner endpoints are open to any user who starts partner onboarding: no profile -> 404 (nothing leaks)
  expectError(await call('GET', '/partner/offers', { token: consumer3.token }), [403, 404], /FORBIDDEN|NOT_FOUND/);
  expectError(await call('GET', '/admin/orders', { token: owner1.token }), [403], /FORBIDDEN/);
  expectError(await call('POST', `/admin/marketplace/restaurants/${RESTAURANTS.tandoorTales.id}/approve`, { token: owner1.token, body: {} }), [403], /FORBIDDEN/);
  expectError(await call('POST', `/owner/orders/${child.id}/accept`, { token: consumer3.token, body: { prepMinutes: 10 } }), [403], /FORBIDDEN/);

  // ---- ownership: another customer's order, another restaurant's order
  expectError(await call('GET', `/orders/${order.checkoutId}`, { token: consumer1.token }), [403, 404]);
  expectError(await call('GET', `/checkouts/${order.checkoutId}`, { token: consumer1.token }), [403, 404]);
  expectError(await call('POST', `/orders/child/${child.id}/cancel`, { token: consumer1.token, body: {} }), [403, 404]);
  expectError(await call('GET', `/payments/checkout/${order.checkoutId}`, { token: consumer1.token }), [403, 404]);
  expectError(await call('GET', `/deliveries/tracking/${child.id}`, { token: consumer1.token }), [403, 404]);
  expectError(await call('GET', `/owner/orders/${child.id}`, { token: owner2.token }), [403, 404]);
  expectError(await call('POST', `/owner/orders/${child.id}/accept`, { token: owner2.token, body: { prepMinutes: 10 } }), [403, 404]);
  expectError(await call('PATCH', `/owner/restaurants/${RESTAURANTS.spiceRoute.id}`, { token: owner2.token, body: { description: 'hijack' } }), [403, 404]);
  expect((await getChild(consumer3.token, order.checkoutId, child.id)).status).toBe('PLACED');

  // ---- invalid lifecycle transitions (409) leave the order unchanged
  expectError(await call('POST', `/owner/orders/${child.id}/ready`, { token: owner1.token }), [409], /INVALID_TRANSITION/);
  expectError(await call('POST', `/owner/orders/${child.id}/preparing`, { token: owner1.token }), [409], /INVALID_TRANSITION/);
  expect((await getChild(consumer3.token, order.checkoutId, child.id)).status).toBe('PLACED');
  await owner.accept(owner1.token, child.id, 10);
  expectError(await call('POST', `/owner/orders/${child.id}/accept`, { token: owner1.token, body: { prepMinutes: 10 } }), [409], /INVALID_TRANSITION/);
  expectError(await call('POST', `/orders/child/${child.id}/cancel`, { token: consumer3.token, body: { reason: 'too late' } }), [409], /INVALID_TRANSITION|CANCEL/);
  // demo payments are owner-only: no token -> 401; another customer -> 403/404 (nothing revealed or changed)
  expectError(await call('GET', `/demo-pay/${order.intentId}`), [401], /UNAUTHENTICATED/);
  expectError(await call('POST', `/demo-pay/${order.intentId}/complete`, { body: { outcome: 'failure' } }), [401], /UNAUTHENTICATED/);
  expectError(await call('GET', `/demo-pay/${order.intentId}`, { token: consumer1.token }), [403, 404]);
  expectError(await call('POST', `/demo-pay/${order.intentId}/complete`, { token: consumer1.token, body: { outcome: 'failure' } }), [403, 404]);
  // the owner may not re-complete an already captured payment
  expectError(await call('POST', `/demo-pay/${order.intentId}/complete`, { token: consumer3.token, body: { outcome: 'failure' } }), [409], /INVALID_TRANSITION/);
  const after = await getChild(consumer3.token, order.checkoutId, child.id);
  expect(after.status).toBe('ACCEPTED');
  expect(after.refundStatus).toBe('NONE');

  // validation errors carry field details
  const bad = await call('PATCH', `/owner/orders/${child.id}/prep-time`, { token: owner1.token, body: { prepMinutes: 1 } });
  expectError(bad, [400], /VALIDATION_FAILED/);
  expect(JSON.stringify(bad.body.error.details)).toContain('prepMinutes');

  // tidy: the restaurant rejects the order (refund path) so it does not linger on the board
  await call('POST', `/owner/orders/${child.id}/reject`, { token: owner1.token, body: { reason: 'e2e cleanup' } });
});

test('UI shows sign-in prompts to guests and no-access states to the wrong role', async ({ browser }) => {
  const g = await newRoleContext(browser);
  const c = await newRoleContext(browser);
  try {
    // guests
    await g.page.goto('/restaurant/orders');
    await expect(g.page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await expect(g.page.getByRole('main').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', /\/signin\?next=%2Frestaurant%2Forders/);
    await g.page.goto('/orders');
    await expect(g.page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    await g.page.goto('/admin');
    await expect(g.page.getByRole('main').getByRole('link', { name: /Sign in|Verify with authenticator/ })).toHaveAttribute('href', /\/admin\/login/);

    // signed-in consumer in other roles' areas
    await signInViaPage(c.page, PHONES.consumer3, '/discover');
    await c.page.goto('/restaurant/orders');
    await expect(c.page.getByRole('heading', { name: 'No restaurant on this account yet' })).toBeVisible();
    await c.page.goto('/partner');
    await expect(c.page.getByRole('heading', { name: "You're not a delivery partner yet" })).toBeVisible();
    await c.page.goto('/admin/orders');
    await expect(c.page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
    await expect(c.page.getByRole('table')).toHaveCount(0);
  } finally {
    await g.context.close();
    await c.context.close();
  }
});
