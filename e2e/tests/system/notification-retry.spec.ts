/**
 * System: SMS provider outage and recovery.
 * The demo-only switch `POST /admin/notifications/demo/fail-mode {sms:true}` (admin + MFA; compose runs
 * SMS_PROVIDER=mock) makes the mock SMS provider fail with a retryable 503. An order is placed: the customer's
 * "order placed" SMS goes FAILED and is retried with backoff (attempts grow) while the in-app notification
 * for the same event is delivered. After the outage ends, the next retry sends it (SENT/DELIVERED).
 * Email is not exercised: compose delivers email to Mailpit, which this switch cannot fail safely.
 * The switch is always turned off in teardown (it also auto-expires after 1 h).
 */
import { expect, test } from '@playwright/test';
import { call, login, ok, placeOrder, waitFor, type Json } from '../../fixtures/api.js';
import { adminToken } from '../../fixtures/admin.js';
import { RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { dotenv } from '../../fixtures/system.js';

test.setTimeout(360_000);

test('SMS outage: FAILED with retries, then SENT after recovery', async () => {
  expect(dotenv('SMS_PROVIDER')).toBe('mock');
  const admin = await adminToken();
  const consumer = await login('consumer2');
  const setFail = (sms: boolean) => call('POST', '/admin/notifications/demo/fail-mode', { token: admin, body: { sms, email: false } });

  const list = async (channel: string): Promise<Json[]> =>
    ok(await call('GET', `/admin/notifications?userId=${consumer.userId}&channel=${channel}&limit=50`, { token: admin }), 'admin notifications').items;

  let orderChild: Json = null;
  try {
    const on = ok(await setFail(true), 'fail-mode on');
    expect(on).toEqual({ sms: true, email: false });
    const t0 = Date.now() - 1000;

    const order = await placeOrder(consumer.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }]);
    orderChild = order.child(RESTAURANTS.spiceRoute.id);
    const mine = (rows: Json[]) => rows.filter((n) => n.template === 'order_placed_customer' && Date.parse(n.createdAt) >= t0);

    // first attempt fails and is scheduled for a retry
    const first = await waitFor('SMS FAILED (attempt 1)', async () => {
      const n = mine(await list('SMS'))[0];
      return n && n.status === 'FAILED' && n.attempts >= 1 ? n : null;
    }, { timeoutMs: 60_000 });
    expect(first.lastError).toMatch(/outage|503/i);
    expect(first.nextAttemptAt).toBeTruthy();
    expect(Date.parse(first.nextAttemptAt)).toBeGreaterThan(Date.parse(first.updatedAt) - 1000);

    // the in-app channel is unaffected by the SMS outage
    await waitFor('in-app notification SENT', async () => {
      const n = mine(await list('IN_APP'))[0];
      return n && ['SENT', 'DELIVERED'].includes(n.status) ? n : null;
    }, { timeoutMs: 60_000 });

    // backoff retry happens and fails again while the outage lasts
    const second = await waitFor('SMS retried (attempt 2) still FAILED', async () => {
      const n = (await list('SMS')).find((x) => x.id === first.id);
      return n && n.attempts >= 2 ? n : null;
    }, { timeoutMs: 120_000, intervalMs: 3000 });
    expect(second.status).toBe('FAILED');
    expect(Date.parse(second.nextAttemptAt) - Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.nextAttemptAt) - Date.parse(first.updatedAt) - 2000); // backoff grows

    // provider recovers -> the next scheduled retry delivers
    expect(ok(await setFail(false), 'fail-mode off')).toEqual({ sms: false, email: false });
    const sent = await waitFor('SMS SENT after recovery', async () => {
      const n = (await list('SMS')).find((x) => x.id === first.id);
      return n && ['SENT', 'DELIVERED'].includes(n.status) ? n : null;
    }, { timeoutMs: 180_000, intervalMs: 3000 });
    expect(sent.attempts).toBeGreaterThanOrEqual(3);
    expect(sent.lastError).toBeNull();
    expect(sent.providerMessageId).toBeTruthy();
    expect(mine(await list('SMS'))).toHaveLength(1); // retried in place, not duplicated
  } finally {
    await setFail(false).catch(() => undefined);
    if (orderChild) {
      const owner1 = await login('owner1');
      await call('POST', `/owner/orders/${orderChild.id}/reject`, { token: owner1.token, body: { reason: 'e2e cleanup' } }).catch(() => undefined);
    }
  }
});
