/**
 * Browser helpers: one context per role (own cookies/localStorage = own session), consumer location choice.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WEB_URL } from './env.js';

export interface RoleContextOptions {
  geolocation?: { latitude: number; longitude: number };
}

/** Fresh context (contexts from `browser.newContext()` do not inherit the config `use` block). */
export async function newRoleContext(browser: Browser, opts: RoleContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1280, height: 900 },
    ...(opts.geolocation ? { geolocation: { ...opts.geolocation, accuracy: 15 }, permissions: ['geolocation'] } : {}),
  });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Landing (no chosen location yet): "Use my location" in the hero (context geolocation) -> reverse geocode ->
 * serviceable -> Discover ("Delivering to <area>"). Not serviceable -> the "We don't deliver here yet" notice.
 */
export async function chooseCurrentLocation(page: Page, expectServiceable = true): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Two kitchens/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Use my location' }).first().click();
  if (expectServiceable) await expect(page.getByRole('heading', { name: /^Delivering to / })).toBeVisible();
  else await expect(page.getByText(/We don.t deliver here yet/)).toBeVisible();
}

/** Owner area: pick the restaurant the switcher shows (persisted selection), then reload the current page. */
export async function selectRestaurant(page: Page, restaurantId: string): Promise<void> {
  await page.evaluate((id) => localStorage.setItem('thali.restaurant.selected', id), restaurantId);
  await page.reload();
}

/** One restaurant's part on the consumer order page ("Delivery N · <restaurant>" card). */
export const childSection = (page: Page, restaurantName: string) =>
  page.getByRole('article', { name: new RegExp(`^Delivery \\d+ · ${escapeRe(restaurantName)}$`) });

/** The child-order status pill in that card's header (not the progress stepper's step labels). */
export const childPill = (page: Page, restaurantName: string, text: string) =>
  childSection(page, restaurantName).locator('span.rounded-pill').filter({ hasText: new RegExp(`^${escapeRe(text)}$`) });

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
