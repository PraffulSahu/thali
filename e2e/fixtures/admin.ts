/**
 * Admin sign-in (password + TOTP from the seed's deterministic demo secret).
 *
 * identity stores the last accepted TOTP step and rejects any step <= it (replay protection), and verifies
 * with a ±1 step window. So each sign-in tries the current step, then the next one, and otherwise waits for
 * a fresh 30 s step.
 */
import { expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_TOTP_SECRET, sleep } from './env.js';
import { call, describeRes, ok, type ApiRes } from './api.js';
import { resetAuthRateLimits } from './stack.js';

const STEP_MS = 30_000;

/** TOTP code for the step `offset` steps from now. */
export function totp(offset = 0): string {
  return authenticator.clone({ epoch: Date.now() + offset * STEP_MS }).generate(ADMIN_TOTP_SECRET);
}

const replayed = (r: ApiRes) => r.status === 401 && /already used/i.test(JSON.stringify(r.body));

let cached: { token: string; exp: number } | null = null;

/** Admin access token via the API (cached for this worker while valid). */
export async function adminToken(): Promise<string> {
  if (cached && cached.exp - Date.now() > 120_000) return cached.token;
  await resetAuthRateLimits();
  for (let round = 0; round < 3; round++) {
    const login = ok(await call('POST', '/auth/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }), 'admin login');
    if (!login.mfaToken) throw new Error(`admin login did not ask for MFA: ${JSON.stringify(login)}`);
    for (const offset of [0, 1]) {
      const r = await call('POST', '/auth/admin/mfa', { body: { mfaToken: login.mfaToken, code: totp(offset) } });
      if (r.status === 200) {
        const token = r.body.accessToken as string;
        const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp * 1000;
        cached = { token, exp };
        return token;
      }
      if (!replayed(r)) throw new Error(`admin MFA: ${describeRes(r)}`);
    }
    await sleep(STEP_MS - (Date.now() % STEP_MS) + 500);
  }
  throw new Error('admin MFA: no fresh TOTP step accepted');
}

/** UI: /admin/login (→ /signin?role=admin) -> work email + password -> authenticator code -> lands on /admin, then `next`. */
export async function adminUiLogin(page: Page, next = '/admin'): Promise<void> {
  await resetAuthRateLimits();
  await page.goto('/admin/login');
  await page.waitForURL(/\/signin\?role=admin/);
  await page.getByLabel('Work email').fill(ADMIN_EMAIL);
  await page.getByLabel(/^Password/).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const codeField = page.getByLabel('Authenticator code');
  await expect(codeField).toBeVisible();
  for (let attempt = 0; attempt < 4; attempt++) {
    const offset = attempt % 2; // current step, next step, (wait) current, next
    if (attempt === 2) await sleep(STEP_MS - (Date.now() % STEP_MS) + 500);
    await codeField.fill(totp(offset)); // the 6th digit submits the code (OtpInput onComplete)
    const verify = page.getByRole('button', { name: 'Verify & continue' });
    if (await verify.isEnabled().catch(() => false)) await verify.click().catch(() => undefined);
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname === '/admin', { timeout: 15_000 }).then(() => 'in' as const),
      page.getByText(/already used|Incorrect|Wait for the next code/i).first().waitFor({ timeout: 15_000 }).then(() => 'retry' as const),
    ]).catch(() => 'unknown' as const);
    if (outcome === 'in') {
      if (next !== '/admin') await page.goto(next);
      return;
    }
  }
  throw new Error('admin UI sign-in failed (TOTP not accepted)');
}
