/**
 * Flow 6: an approved delivery partner accepts an assignment, collects the order and completes delivery.
 * Flow 7: the consumer sees accurate order and delivery progress.
 *
 * The partner works in the real partner UI with browser geolocation (Playwright permission + setGeolocation):
 * go online -> offer for this order -> accept -> arrived -> pickup code (from the restaurant) -> start ->
 * delivery code (shown to the customer). The customer's order page is open the whole time and must follow
 * every step; the API state is checked alongside.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, defaultAddress, getOrder, login, ok, owner, partner, placeOrder, waitFor, type Json } from '../fixtures/api.js';
import { adminToken } from '../fixtures/admin.js';
import { GEO, PHONES, RESTAURANTS, SIMPLE_ITEMS, runTag } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { childSection, newRoleContext } from '../fixtures/ui.js';

test.setTimeout(420_000);

/** Fail stale active jobs and decline live offers left on the demo partner by earlier (aborted) runs. */
async function resetPartner(token: string): Promise<void> {
  const active = await partner.active(token);
  if (active.length) {
    const admin = await adminToken();
    for (const j of active) {
      await call('POST', `/admin/delivery/jobs/${j.id}/fail`, { token: admin, body: { reason: 'e2e cleanup: stale test delivery' } });
    }
  }
  for (const o of await partner.offers(token)) if (o.status === 'OFFERED') await partner.rejectOffer(token, o.id);
}

const pill = (page: Page, restaurant: string, text: string) => childSection(page, restaurant).getByText(text, { exact: true }).first();

test('partner delivers the order; the customer follows every step', async ({ browser }) => {
  const consumer = await login('consumer1');
  const partnerSession = await login('partner1');
  const owner1 = await login('owner1');
  await resetPartner(partnerSession.token);

  const tag = runTag();
  const home = await defaultAddress(consumer.token);
  const order = await placeOrder(consumer.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }], {
    address: { ...home, label: 'E2E', line1: `${tag}, 80 Feet Road, Koramangala` },
  });
  const child = order.child(RESTAURANTS.spiceRoute.id);
  const R = RESTAURANTS.spiceRoute.name;

  const p = await newRoleContext(browser, { geolocation: GEO.nearSpiceRoute });
  const c = await newRoleContext(browser);
  try {
    // ---- partner goes online in the UI (shares the browser location)
    await signInViaPage(p.page, PHONES.partner1, '/partner');
    await expect(p.page.getByRole('heading', { name: 'Partner home', level: 1 })).toBeVisible();
    const toggle = p.page.getByRole('switch');
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.click(); // controlled switch: flips after POST /partner/online
    await expect(p.page.getByRole('switch', { name: 'You are online' })).toBeChecked();
    await expect(p.page.getByTestId('tracking-status')).toContainText('Location sharing active');
    await waitFor('partner location fresh on the server', async () => {
      const prof = await partner.profile(partnerSession.token);
      return prof.online && prof.lastLocationAt && Date.now() - Date.parse(prof.lastLocationAt) < 60_000 ? prof : null;
    });

    // ---- customer opens the order
    await signInViaPage(c.page, PHONES.consumer1, `/orders/${order.checkoutId}`);
    await expect(c.page.getByRole('heading', { name: `Order ${order.code}` })).toBeVisible();
    await expect(pill(c.page, R, 'Placed')).toBeVisible();

    // ---- restaurant: accept -> preparing -> ready (API; the board UI is flow 5/8)
    const accepted = await owner.accept(owner1.token, child.id, 10);
    const pickupCode: string = accepted.pickupCode;
    expect(pickupCode).toMatch(/^\d{4,6}$/);
    await expect(pill(c.page, R, 'Accepted')).toBeVisible();
    const codeBox = childSection(c.page, R).getByText(/^Delivery code/);
    await expect(codeBox).toBeVisible();
    const deliveryCode = (await childSection(c.page, R).locator('span.font-mono').first().innerText()).trim();
    expect(deliveryCode).toBe((await getOrder(consumer.token, order.checkoutId)).checkout.children[0].deliveryCode);

    await owner.preparing(owner1.token, child.id);
    await expect(pill(c.page, R, 'Preparing')).toBeVisible();
    await owner.ready(owner1.token, child.id);
    await expect(pill(c.page, R, 'Ready for pickup')).toBeVisible();

    // ---- dispatch: the offer for this job reaches the partner (other jobs' offers are declined via the API)
    let nudge = 0;
    const offer = await waitFor('offer for this order', async () => {
      const offers = await partner.offers(partnerSession.token);
      for (const o of offers) {
        if (o.status === 'OFFERED' && o.job?.childOrderId !== child.id) await partner.rejectOffer(partnerSession.token, o.id);
      }
      // keep the browser location fresh (watchPosition fires on change)
      nudge = (nudge + 1) % 2;
      await p.context.setGeolocation({ latitude: GEO.nearSpiceRoute.latitude + nudge * 0.0001, longitude: GEO.nearSpiceRoute.longitude, accuracy: 15 });
      return offers.find((o: Json) => o.status === 'OFFERED' && o.job?.childOrderId === child.id) ?? null;
    }, { timeoutMs: 150_000, intervalMs: 3000 });
    expect(offer.job.pickup.name).toBe(R);

    const card = p.page.getByRole('article', { name: `Offer from ${R}` }).filter({ hasText: tag });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Accept delivery' }).click();

    const job = p.page.getByRole('article', { name: `Delivery ${child.id}` });
    await expect(job).toBeVisible();
    await expect(job.getByText('Partner assigned', { exact: true })).toBeVisible();
    await expect(pill(c.page, R, 'Partner assigned')).toBeVisible();
    await expect(childSection(c.page, R)).toContainText('Arjun');

    // ---- collect: arrived -> pickup code
    await job.getByRole('button', { name: "I've arrived at the restaurant" }).click();
    await expect(job.getByText('At restaurant', { exact: true })).toBeVisible();
    await job.getByRole('button', { name: 'Enter pickup code' }).click();
    const pickupDialog = p.page.getByRole('dialog', { name: 'Enter pickup code' });
    await pickupDialog.getByLabel('Pickup code').fill(pickupCode);
    await pickupDialog.getByRole('button', { name: 'Confirm pickup' }).click();
    await expect(job.getByText('Picked up', { exact: true })).toBeVisible();
    await expect(pill(c.page, R, 'Picked up')).toBeVisible();

    // ---- on the way: the partner moves, the customer sees live tracking
    const mid = { latitude: (GEO.nearSpiceRoute.latitude + order.address.location.lat) / 2, longitude: (GEO.nearSpiceRoute.longitude + order.address.location.lng) / 2 };
    await job.getByRole('button', { name: 'Start delivery' }).click();
    await expect(job.getByText('On the way', { exact: true })).toBeVisible();
    await p.context.setGeolocation({ ...mid, accuracy: 10 });
    await expect(pill(c.page, R, 'Out for delivery')).toBeVisible();
    // the tracking hook throttles to one send per 5 s and drops fixes in between: keep producing fixes like a
    // moving device would (alternating by ~1 m)
    let wiggle = 0;
    let lastSeen: Json = null;
    const tracking = await waitFor('tracking shows the moved partner', async () => {
      wiggle = (wiggle + 1) % 2;
      await p.context.setGeolocation({ latitude: mid.latitude + wiggle * 0.00001, longitude: mid.longitude, accuracy: 10 });
      const t = ok(await call('GET', `/deliveries/tracking/${child.id}`, { token: consumer.token }), 'GET tracking');
      lastSeen = t;
      return t.location && Math.abs(t.location.lat - mid.latitude) < 0.0005 && Math.abs(t.location.lng - mid.longitude) < 0.0005 ? t : null;
    }, { timeoutMs: 60_000, intervalMs: 3000 }).catch((e: Error) => {
      throw new Error(`${e.message}; last tracking view: ${JSON.stringify(lastSeen)}`);
    });
    expect(tracking.simulated ?? false).toBe(false);
    await expect(childSection(c.page, R).getByRole('region', { name: 'Delivery partner location' }).or(childSection(c.page, R).getByLabel('Delivery partner location'))).toBeVisible();

    // ---- complete with the customer's code
    await job.getByRole('button', { name: 'Enter delivery code' }).click();
    const dropDialog = p.page.getByRole('dialog', { name: 'Enter delivery code' });
    await dropDialog.getByLabel('Delivery code').fill(deliveryCode);
    await dropDialog.getByRole('button', { name: 'Confirm delivery' }).click();
    await expect(job).toBeHidden();
    await expect(pill(c.page, R, 'Delivered')).toBeVisible();

    // ---- API: final state
    const done = await waitFor('child DELIVERED, checkout COMPLETED', async () => {
      const o = await getOrder(consumer.token, order.checkoutId);
      return o.checkout.children[0].status === 'DELIVERED' && o.checkout.status === 'COMPLETED' ? o : null;
    });
    expect(done.checkout.children[0].deliveryStatus).toBe('DELIVERED');
    const steps = done.checkout.children[0].statusHistory.map((h: Json) => h.to);
    expect(steps).toEqual(expect.arrayContaining(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']));
    const history = ok(await call('GET', '/deliveries/history', { token: partnerSession.token }), 'GET history');
    const histItems: Json[] = Array.isArray(history) ? history : history.items;
    expect(histItems.find((j) => j.childOrderId === child.id)?.status).toBe('DELIVERED');
    expect(await partner.active(partnerSession.token)).toHaveLength(0);
  } finally {
    await call('POST', '/partner/offline', { token: partnerSession.token }).catch(() => undefined);
    await p.context.close();
    await c.context.close();
  }
});
