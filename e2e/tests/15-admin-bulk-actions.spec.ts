/**
 * Admin overview bulk actions (board 40, NTF-2 / NTF-3): "N failed notifications · Retry" and
 * "N dead letters · Replay" in the System health card.
 *
 * Retry: the demo-only SMS outage switch makes the order-placed SMS fail; the overview offers Retry (hidden at 0),
 * the confirm re-queues through POST /admin/notifications/retry and, with the provider back, the SMS is sent.
 * Replay: dead letters can't be produced on demand in a healthy stack, so the health report the page reads gets
 * `details.deadLetters = 2` injected into the notifications service (route interception, this request only); the
 * button, its confirm and the real POST /admin/notifications/dead-letters/replay are exercised end to end. The live
 * `/admin/health` is first checked to carry a numeric `details.deadLetters` for notifications (so the injected
 * shape cannot drift from the real payload), and the replay result must equal that real count.
 */
import { expect, test } from '@playwright/test';
import { call, login, ok, placeOrder, waitFor, type Json } from '../fixtures/api.js';
import { adminToken, adminUiLogin } from '../fixtures/admin.js';
import { RESTAURANTS, SIMPLE_ITEMS, sleep } from '../fixtures/env.js';
import { newRoleContext } from '../fixtures/ui.js';

test.setTimeout(360_000);

/** The whole suite shares one client IP (gateway: 300 requests/min) and the admin overview polls; retry a 429. */
const setFail = async (sms: boolean) => {
  for (let i = 0; ; i++) {
    const r = await call('POST', '/admin/notifications/demo/fail-mode', { token: await adminToken(), body: { sms, email: false } });
    if (r.status !== 429 || i >= 5) return r;
    await sleep(((r.body?.error?.details?.retryAfterSec as number | undefined) ?? 5) * 1000 + 500);
  }
};
const failedCount = async (): Promise<number> => {
  const s = ok(await call('GET', '/admin/notifications/summary', { token: await adminToken() }), 'notifications summary');
  return (s.byStatus?.FAILED ?? 0) + (s.byStatus?.DEAD ?? 0);
};

test('overview: retry failed notifications and replay dead letters', async ({ browser }) => {
  const consumer = await login('consumer2');
  const { context, page } = await newRoleContext(browser);
  let childId: string | null = null;
  try {
    // ---- make one SMS fail (demo outage switch), then end the outage so the retry can succeed
    expect(ok(await setFail(true), 'fail-mode on')).toEqual({ sms: true, email: false });
    const before = await failedCount();
    const order = await placeOrder(consumer.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }]);
    childId = order.child(RESTAURANTS.spiceRoute.id).id;
    await waitFor('a FAILED notification', async () => ((await failedCount()) > before ? true : null), { timeoutMs: 90_000, intervalMs: 5000 });
    expect(ok(await setFail(false), 'fail-mode off')).toEqual({ sms: false, email: false });
    const failed = await failedCount();
    expect(failed).toBeGreaterThan(0);

    // ---- Retry from the overview
    await adminUiLogin(page);
    const retry = page.getByRole('button', { name: /failed notifications? · Retry$/ });
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await retry.click();
    const confirmRetry = page.getByRole('alertdialog', { name: /^Retry \d+ failed notifications?\?$/ }).or(page.getByRole('dialog', { name: /^Retry \d+ failed notifications?\?$/ }));
    await expect(confirmRetry).toBeVisible();
    const retried = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/notifications/retry') && r.request().method() === 'POST');
    await confirmRetry.getByRole('button', { name: 'Retry all' }).click();
    expect((await retried).status()).toBe(200);
    await expect(page.getByText(/re-queued/i).first()).toBeVisible();
    // with the provider back, the re-queued rows go out: fewer failed notifications than before
    await waitFor('failed notifications drop after the retry', async () => ((await failedCount()) < failed ? true : null), { timeoutMs: 120_000, intervalMs: 5000 });

    // ---- Replay: the live health report carries a real numeric dead-letter count for notifications ...
    const live = ok(await call('GET', '/admin/health', { token: await adminToken() }), 'admin health');
    expect(live.services?.notifications, 'notifications in /admin/health').toBeTruthy();
    const realDeadLetters = live.services.notifications.details?.deadLetters as unknown;
    expect(typeof realDeadLetters, `notifications.details.deadLetters = ${JSON.stringify(realDeadLetters)}`).toBe('number');
    // ... then inject 2 into exactly that field of the report this page reads, and use the real endpoint
    await page.route('**/api/v1/admin/health', async (route) => {
      try {
        const res = await route.fetch();
        const body = (await res.json()) as Json;
        const svc = body.services?.notifications;
        if (!svc) throw new Error('admin health has no notifications service');
        svc.details = { ...(svc.details ?? {}), deadLetters: 2 };
        await route.fulfill({ response: res, json: body });
      } catch {
        /* page navigated / test finished while the request was in flight */
      }
    });
    await page.reload();
    const replay = page.getByRole('button', { name: '2 dead letters · Replay' });
    await expect(replay).toBeVisible({ timeout: 30_000 });
    await replay.click();
    const confirmReplay = page.getByRole('alertdialog', { name: 'Replay 2 dead letters?' }).or(page.getByRole('dialog', { name: 'Replay 2 dead letters?' }));
    const replayed = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/notifications/dead-letters/replay') && r.request().method() === 'POST');
    await confirmReplay.getByRole('button', { name: 'Replay all' }).click();
    const res = await replayed;
    expect(res.status()).toBe(200);
    const result = (await res.json()) as Json;
    expect(result.replayed).toBe(realDeadLetters); // the real dead letters (normally 0), not the injected 2
    await expect(page.getByText(/Replayed \d+/).first()).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  } finally {
    const off = await setFail(false);
    expect(off.status, `fail-mode off: ${JSON.stringify(off.body)}`).toBe(200);
    if (childId) await call('POST', `/owner/orders/${childId}/reject`, { token: (await login('owner1')).token, body: { reason: 'e2e cleanup' } });
    await context.close();
  }
});
