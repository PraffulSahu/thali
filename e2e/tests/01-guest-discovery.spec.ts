/**
 * Flow 1: a guest discovers restaurants serving a selected address.
 * UI: location via browser geolocation -> only restaurants that deliver there are listed; an address outside
 * every service area gets the "we don't deliver here" state. API: /discovery/* agrees with what is shown.
 */
import { expect, test } from '@playwright/test';
import { call, ok, type Json } from '../fixtures/api.js';
import { GEO, RESTAURANTS } from '../fixtures/env.js';
import { chooseCurrentLocation, newRoleContext } from '../fixtures/ui.js';

test('guest discovers restaurants that deliver to the chosen location', async ({ browser }) => {
  const at = { lat: GEO.consumer1Home.latitude, lng: GEO.consumer1Home.longitude };

  // ---- API: what the server says is deliverable here
  const service = ok(await call('GET', `/discovery/serviceability?lat=${at.lat}&lng=${at.lng}`), 'serviceability');
  expect(service.serviceable).toBe(true);
  const disco = ok(await call('GET', `/discovery/restaurants?lat=${at.lat}&lng=${at.lng}`), 'discovery');
  expect(disco.serviceable).toBe(true);
  const names: string[] = disco.items.map((r: Json) => r.name);
  expect(names).toEqual(expect.arrayContaining([RESTAURANTS.spiceRoute.name, RESTAURANTS.greenLeaf.name]));
  // not approved -> never listed
  expect(names).not.toContain(RESTAURANTS.tandoorTales.name);
  expect(names).not.toContain(RESTAURANTS.coastalCurry.name);
  for (const r of disco.items as Json[]) {
    expect(r.deliveryFeePaise, `${r.name} delivery fee`).toBeGreaterThanOrEqual(0);
    expect(typeof r.etaMinutes).toBe('number');
  }

  // ---- UI: guest (no session) chooses "current location"
  const { context, page } = await newRoleContext(browser, { geolocation: GEO.consumer1Home });
  try {
    await chooseCurrentLocation(page);
    await expect(page.getByRole('heading', { name: 'Restaurants near you' })).toBeVisible();
    await expect(page.getByText('Delivering to')).toContainText('Current location');
    const list = page.getByRole('region', { name: 'Restaurants' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    for (const n of names) await expect(list.getByRole('link', { name: new RegExp(n) })).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(names.length);
    await expect(list).not.toContainText(RESTAURANTS.tandoorTales.name);
    await expect(list).not.toContainText(RESTAURANTS.coastalCurry.name);
    await expect(page.getByText(new RegExp(`restaurants? deliver to ${disco.serviceArea.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible();

    // veg filter (API + UI agree): Green Leaf is pure veg, Spice Route is not
    const veg = ok(await call('GET', `/discovery/restaurants?lat=${at.lat}&lng=${at.lng}&veg=true`), 'discovery veg');
    expect(veg.items.map((r: Json) => r.name)).toContain(RESTAURANTS.greenLeaf.name);
    expect(veg.items.map((r: Json) => r.name)).not.toContain(RESTAURANTS.spiceRoute.name);

    // open a restaurant: menu visible and the guest may add items (signed-out cart)
    await list.getByRole('link', { name: new RegExp(RESTAURANTS.spiceRoute.name) }).click();
    await expect(page).toHaveURL(/\/restaurants\/spice-route/);
    await expect(page.getByRole('heading', { name: RESTAURANTS.spiceRoute.name, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Paneer Tikka' })).toBeEnabled();

    // ---- a location outside every service area
    await context.setGeolocation({ ...GEO.outside, accuracy: 15 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delivery location' });
    await dialog.getByRole('button', { name: 'Use my current location' }).click();
    await expect(dialog.getByText(/We don.t deliver here yet/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Deliver here' }).click();
    await expect(page.getByRole('heading', { name: /We don.t deliver here yet/ })).toBeVisible();
    const out = ok(await call('GET', `/discovery/restaurants?lat=${GEO.outside.latitude}&lng=${GEO.outside.longitude}`), 'discovery outside');
    expect(out.serviceable).toBe(false);
    expect(out.items).toHaveLength(0);
  } finally {
    await context.close();
  }
});
