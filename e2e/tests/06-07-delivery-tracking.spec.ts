/**
 * Flow 6: an approved delivery partner accepts an assignment, collects the order and completes delivery.
 * Flow 7: the consumer sees accurate order and delivery progress.
 *
 * The partner works in the real partner UI with browser geolocation (Playwright permission + setGeolocation):
 * go online -> offer for this order (drop area only, DLV-2) -> Accept offer -> Call (demo note, DLV-1) -> I’ve
 * arrived -> inline pickup code (from the restaurant) -> Start delivery -> inline delivery code (shown to the
 * customer once a rider is assigned) -> Mark delivered. The customer's order page is open the whole time and must follow
 * every step; the API state is checked alongside.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, defaultAddress, getOrder, login, ok, owner, partner, placeOrder, waitFor, type Json } from '../fixtures/api.js';
import { adminToken } from '../fixtures/admin.js';
import { GEO, PHONES, RESTAURANTS, SIMPLE_ITEMS, runTag } from '../fixtures/env.js';
import { signInViaPage } from '../fixtures/otp.js';
import { childPill, childSection, newRoleContext } from '../fixtures/ui.js';

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

const pill = (page: Page, restaurant: string, text: string) => childPill(page, restaurant, text);

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
    const toggle = p.page.getByRole('switch', { name: 'Online' });
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.click(); // controlled switch: flips after POST /partner/online
    await expect(toggle).toBeChecked();
    await expect(p.page.getByRole('heading', { name: 'You’re online', level: 1 })).toBeVisible();
    await expect(p.page.getByTestId('tracking-status')).toContainText('Location sharing active');
    await waitFor('partner location fresh on the server', async () => {
      const prof = await partner.profile(partnerSession.token);
      return prof.online && prof.lastLocationAt && Date.now() - Date.parse(prof.lastLocationAt) < 60_000 ? prof : null;
    });

    // ---- customer opens the order
    await signInViaPage(c.page, PHONES.consumer1, `/orders/${order.checkoutId}`);
    await expect(c.page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible();
    await expect(pill(c.page, R, 'Placed')).toBeVisible();

    // ---- restaurant: accept -> preparing -> ready (API; the board UI is flow 5/8)
    const accepted = await owner.accept(owner1.token, child.id, 10);
    const pickupCode: string = accepted.pickupCode;
    expect(pickupCode).toMatch(/^\d{4,6}$/);
    await expect(pill(c.page, R, 'Accepted')).toBeVisible();
    const deliveryCode: string = (await getOrder(consumer.token, order.checkoutId)).checkout.children[0].deliveryCode;
    expect(deliveryCode).toMatch(/^\d{4}$/);

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

    // DLV-2: the offer shows the pickup and only the drop area (no customer name / street) until pickup
    const card = p.page.getByRole('region', { name: new RegExp(`^Delivery offer from ${R}`) });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText(tag);
    await expect(card).toContainText('Full address after pickup');
    await card.getByRole('button', { name: 'Accept offer' }).click();

    const job = p.page.getByTestId('active-delivery').filter({ hasText: child.code });
    await expect(job).toBeVisible();
    await expect(job.getByRole('button', { name: 'I’ve arrived' })).toBeVisible();
    await expect(childSection(c.page, R)).toContainText('Arjun');
    // the customer sees the delivery code once a rider is assigned (13-17)
    await expect(childSection(c.page, R).getByRole('group', { name: `Delivery code ${deliveryCode.split('').join(' ')}` })).toBeVisible();

    // ---- call the restaurant: demo mode never dials, it says so (DLV-1)
    await job.getByRole('button', { name: /^Call/ }).first().click();
    await expect(job.getByTestId('contact-note')).toContainText('Calling is simulated in demo');

    // ---- collect: arrived -> inline pickup code -> Confirm pickup
    await job.getByRole('button', { name: 'I’ve arrived' }).click();
    const pickupCodeBoxes = job.getByRole('group', { name: 'Restaurant’s pickup code' });
    await expect(pickupCodeBoxes).toBeVisible();
    await pickupCodeBoxes.getByLabel('Digit 1').pressSequentially(pickupCode);
    const confirmPickup = job.getByRole('button', { name: 'Confirm pickup' });
    if (await confirmPickup.isEnabled().catch(() => false)) await confirmPickup.click().catch(() => undefined);
    await expect(job.getByRole('button', { name: 'Start delivery' })).toBeVisible();
    await expect(pill(c.page, R, 'Picked up')).toBeVisible();

    // ---- on the way: the partner moves, the customer sees live tracking
    const mid = { latitude: (GEO.nearSpiceRoute.latitude + order.address.location.lat) / 2, longitude: (GEO.nearSpiceRoute.longitude + order.address.location.lng) / 2 };
    await job.getByRole('button', { name: 'Start delivery' }).click();
    await expect(job.getByRole('group', { name: 'Customer’s delivery code' })).toBeVisible();
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
    await expect(childSection(c.page, R).getByText(/Location updated/)).toBeVisible();

    // ---- complete with the customer's code (inline boxes) -> Mark delivered
    await job.getByRole('group', { name: 'Customer’s delivery code' }).getByLabel('Digit 1').pressSequentially(deliveryCode);
    const markDelivered = job.getByRole('button', { name: 'Mark delivered' });
    if (await markDelivered.isEnabled().catch(() => false)) await markDelivered.click().catch(() => undefined);
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
