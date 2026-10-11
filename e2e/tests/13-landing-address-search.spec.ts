/**
 * Landing address search (board 00, MKT-1) → Discover with the Bengaluru dataset.
 * A guest types an area into the hero search, picks the first suggestion and lands on Discover for that point:
 * the counts, the first page and the photos are the server's (seeded Bengaluru data, mirrored images), and a
 * cuisine pill narrows the list the way the API does.
 */
import { expect, test } from '@playwright/test';
import { call, ok, type Json } from '../fixtures/api.js';
import { escapeRe, newRoleContext } from '../fixtures/ui.js';

test('landing address search lands on Discover with Bengaluru restaurants', async ({ browser }) => {
  // ---- API: what the gazetteer and discovery say for "Indiranagar"
  const suggestions = ok(await call('GET', '/discovery/places?q=Indiranagar'), 'places').items as Json[];
  expect(suggestions.length).toBeGreaterThan(0);
  const place = ok(await call('GET', `/discovery/places/${suggestions[0].id}`), 'place');
  expect(place.serviceable).toBe(true);
  const { lat, lng } = place.location;
  const disco = ok(await call('GET', `/discovery/restaurants?lat=${lat}&lng=${lng}&sort=distance&limit=24`), 'discovery');
  // the Bengaluru seed: hundreds of restaurants deliver to a central locality
  expect(disco.counts.total).toBeGreaterThan(100);
  expect(disco.items.length).toBe(24);

  const { context, page } = await newRoleContext(browser);
  try {
    await page.goto('/');
    const input = page.getByRole('combobox', { name: 'Enter your delivery address' });
    await input.fill('Indiranagar');
    const options = page.getByRole('listbox', { name: 'Address suggestions' }).getByRole('option');
    await expect(options.first()).toContainText(suggestions[0].primary);
    await options.first().click();

    await expect(page.getByRole('heading', { name: new RegExp(`^Delivering to ${escapeRe(suggestions[0].primary)}`), level: 1 })).toBeVisible();
    await expect(page.getByText(`${disco.counts.open} open now · ${disco.counts.total} restaurants deliver here`)).toBeVisible();
    const list = page.getByRole('list', { name: 'Restaurants' });
    await expect(list.getByRole('listitem')).toHaveCount(disco.items.length);
    // first card = nearest restaurant; its photo is the mirrored seed image and actually loads
    const first = disco.items[0] as Json;
    const firstCard = list.getByRole('listitem').first();
    await expect(firstCard).toContainText(first.name);
    if (first.imageUrl) {
      const img = firstCard.locator('img').first();
      await expect(img).toHaveAttribute('src', first.imageUrl);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    }
    // offer badges come from the server (MKT-8), never invented
    const withOffer = (disco.items as Json[]).filter((r) => r.offer?.badgeLabel);
    for (const r of withOffer.slice(0, 3)) {
      await expect(list.getByRole('listitem').filter({ hasText: r.name }).first()).toContainText(r.offer.badgeLabel);
    }

    // ---- a cuisine pill narrows the list like the API (facet + filter)
    const facet = (disco.facets?.cuisines as Json[] | undefined)?.find((f) => f.count > 0 && f.slug === 'south-indian') ?? disco.facets?.cuisines?.[0];
    expect(facet, 'cuisine facets').toBeTruthy();
    const narrowed = ok(await call('GET', `/discovery/restaurants?lat=${lat}&lng=${lng}&sort=distance&limit=24&cuisine=${facet.slug}`), 'discovery cuisine');
    const cuisines = ok(await call('GET', '/cuisines'), 'cuisines');
    const label: string = ((Array.isArray(cuisines) ? cuisines : cuisines.items) as Json[]).find((c) => c.slug === facet.slug)?.name ?? facet.slug;
    await page.getByRole('list', { name: 'Cuisines' }).getByRole('button', { name: new RegExp(`^${escapeRe(label)}`) }).click();
    await expect(page).toHaveURL(new RegExp(`cuisine=${facet.slug}`));
    await expect(page.getByText(new RegExp(`${narrowed.counts.open} open now · ${narrowed.counts.total} restaurants? deliver`))).toBeVisible();
    await expect(list.getByRole('listitem').first()).toContainText((narrowed.items[0] as Json).name);
  } finally {
    await context.close();
  }
});
