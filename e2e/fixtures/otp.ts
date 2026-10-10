/**
 * UI phone sign-in with the demo OTP (OtpSignInForm: /signin page or the consumer LoginDialog).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { DEMO_OTP, national } from './env.js';
import { resetAuthRateLimits } from './stack.js';

/**
 * Fill the OTP form inside `scope` (page or dialog): phone -> "Send code" -> demo notice -> 6-digit code
 * (the form auto-submits on the 6th digit). Resolves once the form is gone (signed in).
 */
export async function fillOtpForm(scope: Page | Locator, phone: string): Promise<void> {
  resetAuthRateLimits();
  await scope.getByLabel('Mobile number').fill(national(phone));
  await scope.getByRole('button', { name: 'Send code' }).click();
  await expect(scope.getByText('Demo mode: no SMS is sent. Use code 123456.')).toBeVisible();
  const code = scope.getByLabel('6-digit code');
  await code.fill(DEMO_OTP);
  await expect(code).toBeHidden({ timeout: 20_000 });
}

/** `/signin?next=...` then the OTP form; waits until the app navigated to `next`. */
export async function signInViaPage(page: Page, phone: string, next = '/'): Promise<void> {
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole('heading', { name: 'Sign in to Thali' })).toBeVisible();
  await fillOtpForm(page, phone);
  await page.waitForURL((u) => u.pathname === next.split('?')[0]);
}
