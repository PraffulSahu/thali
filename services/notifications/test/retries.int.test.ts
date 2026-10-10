import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, invalidNumber, oid, unavailable, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('retries');
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.models.Notification.deleteMany({}); // dispatchDue() is global
  h.sms.calls = [];
  h.sms.failWith = null;
  h.email.calls = [];
  h.email.failWith = null;
});

let seq = 0;
const enqueueSms = async (over: Record<string, unknown> = {}) =>
  h.dispatcher.enqueue({ channel: 'SMS', template: 'order_delivered', to: '+919876543210', data: { code: 'TH-ABC12345' }, dedupeKey: `t:${++seq}:${oid()}`, ...over });
const advance = (sec: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + sec * 1000);
};
const load = (id: string) => h.models.Notification.findById(id).lean();

describe('retry with exponential backoff', () => {
  it('provider down: FAILED with nextAttemptAt 30s, 60s, 120s... then DEAD after 6 attempts', async () => {
    h.sms.failWith = unavailable();
    const { id } = await enqueueSms();
    const expectedDelays = [30, 60, 120, 240, 480];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const t = h.clock.now.getTime();
      await h.dispatcher.dispatchDue();
      const doc = await load(id);
      expect(doc!.status).toBe('FAILED');
      expect(doc!.attempts).toBe(attempt);
      expect(doc!.nextAttemptAt!.getTime() - t).toBe(expectedDelays[attempt - 1]! * 1000);
      expect(doc!.lastError).toContain('503');
      // not due yet: another poll right away must not call the provider
      const calls = h.sms.calls.length;
      await h.dispatcher.dispatchDue();
      expect(h.sms.calls.length).toBe(calls);
      advance(expectedDelays[attempt - 1]!);
    }
    await h.dispatcher.dispatchDue();
    const dead = await load(id);
    expect(dead!.status).toBe('DEAD');
    expect(dead!.attempts).toBe(6);
    expect(dead!.nextAttemptAt).toBeNull();
    expect(h.sms.calls).toHaveLength(6);
    // DEAD is never picked up again
    advance(86_400);
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(6);
  });

  it('provider recovers mid-way -> SENT with provider id and no further retries', async () => {
    h.sms.failWith = unavailable();
    const { id } = await enqueueSms();
    await h.dispatcher.dispatchDue();
    advance(30);
    h.sms.failWith = null;
    await h.dispatcher.dispatchDue();
    const doc = await load(id);
    expect(doc).toMatchObject({ status: 'SENT', attempts: 2, provider: 'twilio' });
    expect(doc!.providerMessageId).toMatch(/^SM/);
    expect(doc!.nextAttemptAt).toBeNull();
    expect(doc!.lastError ?? null).toBeNull();
  });

  it('permanent 4xx error (invalid number) -> DEAD immediately, no retries', async () => {
    h.sms.failWith = invalidNumber();
    const { id } = await enqueueSms();
    await h.dispatcher.dispatchDue();
    const doc = await load(id);
    expect(doc).toMatchObject({ status: 'DEAD', attempts: 1 });
    expect(doc!.lastError).toContain('21211');
    advance(3600);
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(1);
  });

  it('email retries reuse the dedupeKey as the provider idempotency key', async () => {
    h.email.failWith = new Error('socket hang up'); // unknown errors are treated as retryable
    const { id } = await h.dispatcher.enqueue({ channel: 'EMAIL', template: 'order_delivered', to: 'asha@example.com', data: { code: 'TH-1' }, dedupeKey: 'idem-key-1' });
    await h.dispatcher.dispatchDue();
    advance(30);
    h.email.failWith = null;
    await h.dispatcher.dispatchDue();
    expect(h.email.calls.map((c) => c.idempotencyKey)).toEqual(['idem-key-1', 'idem-key-1']);
    expect((await load(id))!.status).toBe('SENT');
  });

  it('two concurrent dispatches of the same notification call the provider once', async () => {
    const { id } = await enqueueSms();
    await Promise.all([h.dispatcher.dispatchById(id), h.dispatcher.dispatchById(id), h.dispatcher.dispatchDue()]);
    expect(h.sms.calls).toHaveLength(1);
  });

  it('a notification stuck in SENDING (crashed instance) becomes due again after the timeout', async () => {
    const { id } = await enqueueSms();
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'SENDING', attempts: 1, sendingAt: h.clock.now } });
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(0);
    advance(h.config.NOTIF_SENDING_TIMEOUT_SEC + 1);
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(1);
    expect((await load(id))).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('dedupeKey is unique: enqueueing twice yields one record', async () => {
    const a = await h.dispatcher.enqueue({ channel: 'SMS', template: 'order_delivered', to: '+919876543210', data: { code: 'X' }, dedupeKey: 'same-key' });
    const b = await h.dispatcher.enqueue({ channel: 'SMS', template: 'order_delivered', to: '+919876543210', data: { code: 'X' }, dedupeKey: 'same-key' });
    expect(b.id).toBe(a.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await h.models.Notification.countDocuments({ dedupeKey: 'same-key' })).toBe(1);
  });
});

/** Make the "mark SENT" write fail `times` times (the provider call itself keeps working). */
function failSentWrites(times: number) {
  const orig = h.models.Notification.findOneAndUpdate.bind(h.models.Notification);
  let remaining = times;
  return vi.spyOn(h.models.Notification, 'findOneAndUpdate').mockImplementation(((filter: unknown, update: any, opts: unknown) => {
    if (update?.$set?.status === 'SENT' && remaining-- > 0) return { lean: () => Promise.reject(new Error('mongo unavailable')) };
    return (orig as any)(filter, update, opts);
  }) as never);
}

describe('a bookkeeping failure after the provider accepted the message never causes a duplicate send', () => {
  it('transient write failure: the write is retried, the provider is called once, status ends SENT', async () => {
    const { id } = await enqueueSms();
    const spy = failSentWrites(1);
    try {
      await h.dispatcher.dispatchById(id);
    } finally {
      spy.mockRestore();
    }
    expect(h.sms.calls).toHaveLength(1);
    expect(await load(id)).toMatchObject({ status: 'SENT', attempts: 1, provider: 'twilio' });
    advance(3600);
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(1);
  });

  it('persistent write failure: no FAILED/retry is scheduled (row stays SENDING), nothing is re-sent by the poller', async () => {
    const { id } = await enqueueSms();
    const spy = failSentWrites(99);
    try {
      await h.dispatcher.dispatchById(id);
    } finally {
      spy.mockRestore();
    }
    expect(h.sms.calls).toHaveLength(1);
    const doc = await load(id);
    expect(doc).toMatchObject({ status: 'SENDING', attempts: 1 });
    expect(doc!.lastError ?? null).toBeNull();
    advance(60); // before the stuck-SENDING timeout
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(1);
  });

  it('a provider failure is still a failure (FAILED + backoff), unlike a post-send write failure', async () => {
    h.sms.failWith = unavailable();
    const { id } = await enqueueSms();
    await h.dispatcher.dispatchById(id);
    expect(await load(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
  });
});

describe('POST /api/v1/admin/notifications/:id/retry', () => {
  const retry = async (id: string, token: string) =>
    request(h.app).post(`/api/v1/admin/notifications/${id}/retry`).set('authorization', `Bearer ${token}`).send({});

  it('resets DEAD -> QUEUED (attempts 0), writes an audit event, and the notification is then delivered', async () => {
    h.sms.failWith = unavailable();
    const { id } = await enqueueSms();
    for (let i = 0; i < 6; i++) {
      await h.dispatcher.dispatchDue();
      advance(1000);
    }
    expect((await load(id))!.status).toBe('DEAD');

    h.sms.failWith = null;
    const res = await retry(id, await h.adminToken());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'QUEUED', attempts: 0 });
    const queued = await load(id);
    expect(queued).toMatchObject({ status: 'QUEUED', attempts: 0 });

    h.sms.calls = [];
    await h.dispatcher.dispatchDue();
    expect((await load(id))!.status).toBe('SENT');
    expect(h.sms.calls).toHaveLength(1);

    const audit = await h.conn.collection('outbox').findOne({ 'envelope.type': 'audit.recorded', 'envelope.payload.targetId': id });
    expect(audit).toBeTruthy();
    expect(audit!.stream).toBe('events.notifications');
    expect(audit!.envelope.payload).toMatchObject({ action: 'notification.retry', targetType: 'notification', service: 'notifications', actorRole: 'ADMIN:OPS' });
  });

  it('conflict when the notification is not retryable (SENT) and 404 for unknown ids', async () => {
    const { id } = await enqueueSms();
    await h.dispatcher.dispatchDue();
    expect((await retry(id, await h.adminToken())).status).toBe(409);
    expect((await retry(oid(), await h.adminToken())).status).toBe(404);
  });

  it('OTP records are not retryable (the code was never stored)', async () => {
    h.sms.failWith = unavailable();
    await request(h.app).post('/internal/notifications/otp').set('authorization', `Bearer ${await h.serviceToken('identity')}`).send({ phone: '+919876543210', code: '111111' });
    const otp = await h.models.Notification.findOne({ template: 'otp' }).sort({ _id: -1 }).lean();
    expect((await retry(String(otp!._id), await h.adminToken())).status).toBe(409);
  });

  it('requires ADMIN with MFA', async () => {
    const { id } = await enqueueSms();
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'DEAD' } });
    expect((await request(h.app).post(`/api/v1/admin/notifications/${id}/retry`)).status).toBe(401);
    expect((await retry(id, await h.userToken('u'.repeat(24)))).status).toBe(403);
    const noMfa = await retry(id, await h.adminToken(undefined, { mfa: false }));
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
  });
});
