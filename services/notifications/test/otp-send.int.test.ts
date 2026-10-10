import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, beforeEach } from 'vitest';
import { createHarness, unavailable, type Harness } from './helpers.js';

const CODE = '483920';
const PHONE = '+919876543210';
let h: Harness;

beforeAll(async () => {
  h = await createHarness('otp');
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.sms.calls = [];
  h.sms.failWith = null;
});

const post = async (body: unknown, from: 'identity' | 'orders' = 'identity') =>
  request(h.app).post('/internal/notifications/otp').set('authorization', `Bearer ${await h.serviceToken(from)}`).send(body as object);

describe('POST /internal/notifications/otp', () => {
  it('sends the code through the SMS provider and persists a record WITHOUT the code', async () => {
    const res = await post({ phone: PHONE, code: CODE });
    expect(res.status).toBe(202);
    expect(res.body.notificationId).toMatch(/^[0-9a-f]{24}$/);

    expect(h.sms.calls).toHaveLength(1);
    expect(h.sms.calls[0]!.to).toBe(PHONE);
    expect(h.sms.calls[0]!.body).toContain(CODE);

    const doc = await h.models.Notification.findById(res.body.notificationId).lean();
    expect(doc).toMatchObject({ template: 'otp', channel: 'SMS', status: 'SENT', attempts: 1, provider: 'twilio' });
    expect(doc!.data).toEqual({});
    // nothing in the stored document (including encrypted + masked fields) leaks the code or the plain phone
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain(CODE);
    expect(raw).not.toContain(PHONE);
    expect(doc!.to).toMatch(/^\+91\*+3210$/);
    expect(doc!.toEnc).toMatch(/^v1:/);
    expect(doc!.title ?? '').not.toContain(CODE);
    expect(doc!.body ?? '').not.toContain(CODE);
  });

  it('normalizes phone variants before sending', async () => {
    const res = await post({ phone: '098765 43210', code: CODE });
    expect(res.status).toBe(202);
    expect(h.sms.calls[0]!.to).toBe(PHONE);
  });

  it('provider failure -> 503 OTP_DELIVERY_FAILED and the record is FAILED (no retry scheduled, no code stored)', async () => {
    h.sms.failWith = unavailable();
    const res = await post({ phone: PHONE, code: CODE });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(CODE);

    const doc = await h.models.Notification.findOne({ template: 'otp' }).sort({ _id: -1 }).lean();
    expect(doc!.status).toBe('FAILED');
    expect(doc!.nextAttemptAt).toBeNull(); // a stale OTP must never be retried by the worker
    expect(doc!.lastError).toBeTruthy();
    expect(JSON.stringify(doc)).not.toContain(CODE);

    // the retry worker ignores it
    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000);
    h.sms.failWith = null;
    h.sms.calls = [];
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls).toHaveLength(0);
  });

  it('never logs the code or the phone number', async () => {
    h.sms.failWith = unavailable();
    await post({ phone: PHONE, code: CODE });
    h.sms.failWith = null;
    await post({ phone: PHONE, code: CODE });
    expect(h.logs.text).not.toContain(CODE);
    expect(h.logs.text).not.toContain(PHONE);
  });

  it('validates the body', async () => {
    expect((await post({ phone: '12', code: CODE })).status).toBe(400);
    expect((await post({ phone: PHONE, code: 'abc' })).status).toBe(400);
    expect((await post({ phone: PHONE })).status).toBe(400);
  });

  it('is internal only: no token 401, user token 401, other services 403', async () => {
    expect((await request(h.app).post('/internal/notifications/otp').send({ phone: PHONE, code: CODE })).status).toBe(401);
    const user = await h.userToken('u'.repeat(24));
    expect((await request(h.app).post('/internal/notifications/otp').set('authorization', `Bearer ${user}`).send({ phone: PHONE, code: CODE })).status).toBe(401);
    expect((await post({ phone: PHONE, code: CODE }, 'orders')).status).toBe(403);
  });
});
