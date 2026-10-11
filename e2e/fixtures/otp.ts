/**
 * UI phone sign-in with the demo OTP (OtpSignInForm: /signin page or the consumer LoginDialog).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { DEMO_OTP, national, sleep } from './env.js';
import { resetAuthRateLimits } from './stack.js';

/**
 * Fill the OTP form inside `scope` (page or dialog): phone -> "Send code" -> demo notice -> 6-digit code
 * (the form auto-submits on the 6th digit). Resolves once the form is gone (signed in).
 */
export async function fillOtpForm(scope: Page | Locator, phone: string): Promise<void> {
  await resetAuthRateLimits();
  await scope.getByLabel('Mobile number').fill(national(phone));
  const notice = scope.getByText('Demo mode: no SMS is sent. Use code 123456.');
  // The resend cooldown (30 s per phone) also lives on identity's OTP record, not only in the Redis counters reset
  // above: a phone signed in by the previous spec seconds ago gets "Please wait 0:0N…". Wait it out once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await scope.getByRole('button', { name: 'Send code' }).click();
    const wait = scope.getByText(/Please wait (\d+):(\d+) before requesting another code/);
    const outcome = await Promise.race([
      notice.waitFor({ timeout: 20_000 }).then(() => 'sent' as const),
      wait.waitFor({ timeout: 20_000 }).then(() => 'cooldown' as const),
    ]);
    if (outcome === 'sent') break;
    const [, m, sec] = (await wait.innerText()).match(/(\d+):(\d+)/)!;
    const waitSec = Number(m) * 60 + Number(sec) + 1;
    // visible in the run log, so a regression that puts first sends under the cooldown does not go unnoticed
    console.log(`[e2e otp] ${phone}: resend cooldown (${m}:${sec}), waiting ${waitSec} s before sending again`);
    await sleep(waitSec * 1000);
  }
  await expect(notice).toBeVisible();
  const code = scope.getByLabel('6-digit code');
  await code.fill(DEMO_OTP);
  await expect(code).toBeHidden({ timeout: 20_000 });
}

/** `/signin?next=...` then the OTP form; waits until the app navigated to `next`. */
export async function signInViaPage(page: Page, phone: string, next = '/'): Promise<void> {
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await fillOtpForm(page, phone);
  await page.waitForURL((u) => u.pathname === next.split('?')[0]);
}
