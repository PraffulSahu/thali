/**
 * Dark mode (design-spec §2, board 02): the header theme toggle switches the whole app to dark, the choice is
 * stored (`thali.theme`) and survives a reload and a different area; the public utility bar's segmented control
 * reflects and changes the same preference.
 */
import { expect, test } from '@playwright/test';
import { newRoleContext } from '../fixtures/ui.js';

test('dark-mode toggle persists across reloads and areas', async ({ browser }) => {
  const { context, page } = await newRoleContext(browser);
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/welcome');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    // public utility bar: Light | Dark | System radiogroup
    const theme = page.getByRole('radiogroup', { name: 'Theme' }).first();
    await theme.getByRole('radio', { name: /Dark/ }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('thali.theme'))).toBe('dark');
    // the dark palette really applies (not just the attribute): the page background ends up dark (after the
    // colour transition)
    const brightness = () => page.evaluate(() => (getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0));
    await expect.poll(brightness, { timeout: 5_000 }).toBeLessThan(100);

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // another area (sign-in page): still dark; its toggle switches back to light, which persists too
    await page.goto('/signin');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('thali.theme'))).toBe('light');
  } finally {
    await context.close();
  }
});
