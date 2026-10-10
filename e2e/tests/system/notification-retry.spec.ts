/**
 * System: SMS provider outage and recovery.
 * The demo-only switch `POST /admin/notifications/demo/fail-mode {sms:true}` (admin + MFA; compose runs
 * SMS_PROVIDER=mock) makes the mock SMS provider fail with a retryable 503. An order is placed: the customer's
 * "order placed" SMS goes FAILED and is retried with backoff (attempts grow) while the in-app notification
 * for the same event is delivered. After the outage ends, the next retry sends it (SENT/DELIVERED).
 * Email is not exercised: compose delivers email to Mailpit, which this switch cannot fail safely.
 * Teardown always turns the switch off and fails loudly if that did not work (it also auto-expires after 1 h).
 *
 * The SMS row is tied to THIS order without time windows: the customer's in-app "order placed" notification
 * carries data.childOrderId; its admin view gives the source event id, shared by the SMS row of that event.
 */
import { expect, test } from '@playwright/test';
import { call, login, ok, placeOrder, waitFor, type Json } from '../../fixtures/api.js';
import { adminToken } from '../../fixtures/admin.js';
import { RESTAURANTS, SIMPLE_ITEMS } from '../../fixtures/env.js';
import { dotenv } from '../../fixtures/system.js';

test.setTimeout(360_000);

const TEMPLATE = 'order_placed_customer';
/** Fresh (cached-while-valid) admin token per call: the scenario outlives short access tokens. */
const setFail = async (sms: boolean) => call('POST', '/admin/notifications/demo/fail-mode', { token: await adminToken(), body: { sms, email: false } });
const adminList = async (userId: string, channel: string): Promise<Json[]> =>
  ok(await call('GET', `/admin/notifications?userId=${userId}&channel=${channel}&limit=100`, { token: await adminToken() }), 'admin notifications').items;

test('SMS outage: FAILED with retries, then SENT after recovery', async () => {
  expect(dotenv('SMS_PROVIDER')).toBe('mock');
  const consumer = await login('consumer2');

  let orderChildId: string | null = null;
  try {
    expect(ok(await setFail(true), 'fail-mode on')).toEqual({ sms: true, email: false });

    const order = await placeOrder(consumer.token, [{ restaurant: SIMPLE_ITEMS.paneerTikka.restaurant, name: SIMPLE_ITEMS.paneerTikka.name }]);
    orderChildId = order.child(RESTAURANTS.spiceRoute.id).id;

    // the in-app notification for this order is delivered despite the SMS outage -> its source event id
    const inbox = await waitFor('in-app "order placed" for this order', async () => {
      const r = ok(await call('GET', '/notifications?limit=50', { token: consumer.token }), 'GET /notifications');
      return (r.items as Json[]).find((n) => n.template === TEMPLATE && n.data?.childOrderId === orderChildId) ?? null;
    }, { timeoutMs: 60_000 });
    const inApp = (await adminList(consumer.userId, 'IN_APP')).find((n) => n.id === inbox.id);
    expect(inApp?.status).toMatch(/SENT|DELIVERED/);
    const sourceEventId: string = inApp.sourceEventId;
    expect(sourceEventId).toBeTruthy();
    const sms = async () => (await adminList(consumer.userId, 'SMS')).filter((n) => n.template === TEMPLATE && n.sourceEventId === sourceEventId);

    // first attempt fails and is scheduled for a retry
    const first = await waitFor('SMS FAILED (attempt 1)', async () => {
      const n = (await sms())[0];
      return n && n.status === 'FAILED' && n.attempts >= 1 ? n : null;
    }, { timeoutMs: 60_000 });
    expect(first.lastError).toMatch(/outage|503/i);
    expect(first.nextAttemptAt).toBeTruthy();

    // backoff retry happens and fails again while the outage lasts
    const second = await waitFor('SMS retried (attempt 2) still FAILED', async () => {
      const n = (await sms())[0];
      return n && n.attempts >= 2 ? n : null;
    }, { timeoutMs: 120_000, intervalMs: 3000 });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('FAILED');
    expect(Date.parse(second.nextAttemptAt) - Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.nextAttemptAt) - Date.parse(first.updatedAt) - 2000); // backoff grows

    // provider recovers -> the next scheduled retry delivers
    expect(ok(await setFail(false), 'fail-mode off')).toEqual({ sms: false, email: false });
    const sent = await waitFor('SMS SENT after recovery', async () => {
      const n = (await sms())[0];
      return n && ['SENT', 'DELIVERED'].includes(n.status) ? n : null;
    }, { timeoutMs: 180_000, intervalMs: 3000 });
    expect(sent.id).toBe(first.id);
    expect(sent.attempts).toBeGreaterThanOrEqual(3);
    expect(sent.lastError).toBeNull();
    expect(sent.providerMessageId).toBeTruthy();
    expect(await sms()).toHaveLength(1); // retried in place, not duplicated
  } finally {
    // restore the provider: must succeed, otherwise the demo stays broken for up to an hour
    const off = await setFail(false);
    expect(off.status, `fail-mode off: ${JSON.stringify(off.body)}`).toBe(200);
    expect(off.body).toEqual({ sms: false, email: false });
    if (orderChildId) {
      const r = await call('POST', `/owner/orders/${orderChildId}/reject`, { token: (await login('owner1')).token, body: { reason: 'e2e cleanup' } });
      expect([200, 409], `cleanup reject: ${JSON.stringify(r.body)}`).toContain(r.status);
    }
  }
});
