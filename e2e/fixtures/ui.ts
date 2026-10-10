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

/** Consumer home with no chosen location: "Use my current location" (context geolocation) -> "Deliver here". */
export async function chooseCurrentLocation(page: Page, expectServiceable = true): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where should we deliver?' })).toBeVisible();
  await page.getByRole('button', { name: 'Use my current location' }).click();
  if (expectServiceable) await expect(page.getByText(/We deliver here/)).toBeVisible();
  await page.getByRole('button', { name: 'Deliver here' }).click();
}

/** The status pill(s) inside a restaurant's section on the consumer order page. */
export const childSection = (page: Page, restaurantName: string) => page.getByRole('region', { name: restaurantName, exact: true });
