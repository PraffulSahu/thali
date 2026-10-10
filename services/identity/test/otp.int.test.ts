import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAuthVerifier } from '@thali/service-kit';
import { createHarness, loginWithOtp, randomPhone, rawSetCookie, refreshCookie, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('otp');
});
afterAll(async () => {
  await h?.close();
});

const challenges = () => h.db.conn.collection('otp_challenges');
const users = () => h.db.conn.collection('users');
const outbox = () => h.db.conn.collection('outbox');

async function requestOtp(app = h.app, phone: string) {
  return request(app).post('/api/v1/auth/otp/request').send({ phone });
}
async function verify(app = h.app, phone: string, code: string, extra: Record<string, unknown> = {}) {
  return request(app).post('/api/v1/auth/otp/verify').send({ phone, code, ...extra });
}

describe('POST /auth/otp/request', () => {
  it('stores the challenge hashed (raw code never stored) and sends it via notifications', async () => {
    const phone = randomPhone();
    const res = await requestOtp(h.app, phone);
    expect(res.status).toBe(200);
    expect(res.body.demoOtp).toBeUndefined();
    const code = h.notifications.lastCode(phone);
    expect(code).toMatch(/^[0-9]{6}$/);
    const docs = await challenges().find({ phone }).toArray();
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.codeHash).not.toBe(code);
    expect(JSON.stringify(doc)).not.toContain(`"${code}"`);
    expect(doc.purpose).toBe('LOGIN');
    expect(doc.maxAttempts).toBe(5);
    expect(doc.attempts).toBe(0);
    expect(doc.consumedAt ?? null).toBeNull();
    expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('second request within 30 s → 429 with Retry-After', async () => {
    const phone = randomPhone();
    expect((await requestOtp(h.app, phone)).status).toBe(200);
    const res = await requestOtp(h.app, phone);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    const retry = Number(res.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(30);
  });

  it('6th request in an hour → 429', async () => {
    const app = h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' });
    const phone = randomPhone();
    for (let i = 0; i < 5; i++) expect((await requestOtp(app, phone)).status).toBe(200);
    const res = await requestOtp(app, phone);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('per-IP limit applies across phones', async () => {
    const app = h.appWith({ OTP_MAX_PER_IP_PER_HOUR: '2' });
    // distinct client IP (trust proxy = loopback honours X-Forwarded-For from supertest)
    const from = (phone: string) => request(app).post('/api/v1/auth/otp/request').set('X-Forwarded-For', '10.9.8.7').send({ phone });
    expect((await from(randomPhone())).status).toBe(200);
    expect((await from(randomPhone())).status).toBe(200);
    const res = await from(randomPhone());
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('invalid phone → 400 VALIDATION_FAILED', async () => {
    const res = await requestOtp(h.app, '12345');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('notification failure → 503 OTP_DELIVERY_FAILED and the challenge is not counted as sent', async () => {
    const phone = randomPhone();
    h.notifications.fail = true;
    try {
      const res = await requestOtp(h.app, phone);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    } finally {
      h.notifications.fail = false;
    }
    expect(await challenges().countDocuments({ phone, sentAt: { $ne: null } })).toBe(0);
    // not counted: an immediate retry is not blocked by the resend cooldown
    const retry = await requestOtp(h.app, phone);
    expect(retry.status).toBe(200);
  });

  it('new request invalidates the previous code', async () => {
    const app = h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' });
    const phone = randomPhone();
    await requestOtp(app, phone);
    const first = h.notifications.lastCode(phone);
    await requestOtp(app, phone);
    const second = h.notifications.lastCode(phone);
    if (first !== second) {
      const old = await verify(app, phone, first);
      expect(old.status).toBe(400);
      expect(old.body.error.code).toBe('OTP_INVALID');
    }
    expect((await verify(app, phone, second)).status).toBe(200);
  });
});

describe('POST /auth/otp/verify', () => {
  it('correct code → 200 with accessToken (verifiable via JWKS) + HttpOnly SameSite=Strict thali_rt cookie', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    const res = await verify(h.app, phone, h.notifications.lastCode(phone));
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.phone).toBe(phone);
    expect(res.body.user.roles).toEqual(['CONSUMER']);
    const sc = rawSetCookie(res)!;
    expect(sc).toBeDefined();
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\/api\/v1\/auth/);
    expect(sc).not.toMatch(/;\s*Secure/i); // demo over http
    expect(refreshCookie(res)).toMatch(/^thali_rt=.{40,}$/);

    const jwks = await request(h.app).get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys[0].kid).toBeTruthy();
    expect(jwks.body.keys[0].d).toBeUndefined();
    const verifier = createAuthVerifier({ jwks: jwks.body, redis: h.tr.redis });
    const ctx = await verifier.verify(res.body.accessToken);
    expect(ctx.userId).toBe(res.body.user.id);
    expect(ctx.roles).toEqual(['CONSUMER']);
    expect(ctx.amr).toEqual(['otp']);
    expect(ctx.sessionId).toBeTruthy();
  });

  it('COOKIE_SECURE=true sets the Secure flag', async () => {
    const app = h.appWith({ COOKIE_SECURE: 'true' });
    const phone = randomPhone();
    await requestOtp(app, phone);
    const res = await verify(app, phone, h.notifications.lastCode(phone));
    expect(rawSetCookie(res)).toMatch(/;\s*Secure/i);
  });

  it('wrong code ×5 → 6th attempt 429 OTP_ATTEMPTS_EXCEEDED even with the right code', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    const code = h.notifications.lastCode(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await verify(h.app, phone, wrong);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('OTP_INVALID');
    }
    const r6 = await verify(h.app, phone, code);
    expect(r6.status).toBe(429);
    expect(r6.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('expired challenge → 400 OTP_EXPIRED', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    await challenges().updateMany({ phone }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await verify(h.app, phone, h.notifications.lastCode(phone));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('OTP_EXPIRED');
  });

  it('reusing the same code → 400 OTP_INVALID (single use)', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    const code = h.notifications.lastCode(phone);
    expect((await verify(h.app, phone, code)).status).toBe(200);
    const again = await verify(h.app, phone, code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('OTP_INVALID');
  });

  it('verify without any challenge → 400 OTP_INVALID', async () => {
    const r = await verify(h.app, randomPhone(), '123456');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('OTP_INVALID');
  });

  it('concurrent verify of the same code → exactly one success', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    const code = h.notifications.lastCode(phone);
    const results = await Promise.all([verify(h.app, phone, code), verify(h.app, phone, code)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(await users().countDocuments({ phone })).toBe(1);
  });

  it('phone variants normalize to the same user', async () => {
    const app = h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' });
    const a = await loginWithOtp(app, h, '+91 98765 43210');
    const b = await loginWithOtp(app, h, '09876543210');
    const c = await loginWithOtp(app, h, '919876543210');
    expect(b.userId).toBe(a.userId);
    expect(c.userId).toBe(a.userId);
    expect(await users().countDocuments({ phone: '+919876543210' })).toBe(1);
  });

  it('new user gets roles [CONSUMER] and a user.registered outbox event (once)', async () => {
    const app = h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' });
    const phone = randomPhone();
    const first = await loginWithOtp(app, h, phone);
    const u = await users().findOne({ phone });
    expect(u!.roles).toEqual(['CONSUMER']);
    expect(u!.status).toBe('ACTIVE');
    expect(u!.notificationPrefs).toEqual({ orderSms: true, orderEmail: true, marketingSms: false, marketingEmail: false });
    await loginWithOtp(app, h, phone);
    const events = await outbox().find({ 'envelope.type': 'user.registered', 'envelope.payload.userId': first.userId }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.stream).toBe('events.identity');
    expect(events[0]!.envelope.payload).toEqual({ userId: first.userId, phone });
    expect(events[0]!.envelope.producer).toBe('identity');
  });

  it('blocked user → 403 ACCOUNT_BLOCKED', async () => {
    const app = h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' });
    const phone = randomPhone();
    await loginWithOtp(app, h, phone);
    await users().updateOne({ phone }, { $set: { status: 'BLOCKED' } });
    await requestOtp(app, phone);
    const r = await verify(app, phone, h.notifications.lastCode(phone));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('guestCartToken → orders /internal/cart/merge called; failure is best-effort (guestCartMerged:false)', async () => {
    const phone = randomPhone();
    await requestOtp(h.app, phone);
    const ok = await verify(h.app, phone, h.notifications.lastCode(phone), { guestCartToken: 'guest-abc' });
    expect(ok.status).toBe(200);
    expect(ok.body.guestCartMerged).toBe(true);
    expect(h.orders.calls.at(-1)).toEqual({ userId: ok.body.user.id, guestToken: 'guest-abc' });

    const phone2 = randomPhone();
    h.orders.fail = true;
    try {
      await requestOtp(h.app, phone2);
      const res = await verify(h.app, phone2, h.notifications.lastCode(phone2), { guestCartToken: 'guest-def' });
      expect(res.status).toBe(200);
      expect(res.body.guestCartMerged).toBe(false);
      expect(res.body.accessToken).toBeTruthy();
    } finally {
      h.orders.fail = false;
    }
  });
});

describe('demo OTP', () => {
  const demoPhone = '+919999900001';
  const env = { APP_MODE: 'demo', DEMO_OTP_ENABLED: 'true', DEMO_PHONES: '+91 99999 00001', OTP_RESEND_COOLDOWN_SEC: '0' };

  it('123456 accepted for a listed phone in demo mode (no SMS sent, demoOtp:true)', async () => {
    const app = h.appWith(env);
    const before = h.notifications.sent.length;
    const r1 = await requestOtp(app, demoPhone);
    expect(r1.status).toBe(200);
    expect(r1.body.demoOtp).toBe(true);
    expect(h.notifications.sent.length).toBe(before);
    expect(await challenges().countDocuments({ phone: demoPhone })).toBeGreaterThan(0);
    const r2 = await verify(app, demoPhone, '123456');
    expect(r2.status).toBe(200);
    expect(r2.body.demoOtp).toBe(true);
  });

  it('rejected for a non-listed phone', async () => {
    const app = h.appWith(env);
    const phone = randomPhone();
    const r1 = await requestOtp(app, phone);
    expect(r1.body.demoOtp).toBeUndefined();
    if (h.notifications.lastCode(phone) === '123456') return; // 1-in-a-million collision
    const r2 = await verify(app, phone, '123456');
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('OTP_INVALID');
  });

  it('rejected in sandbox mode', async () => {
    const app = h.appWith({ ...env, APP_MODE: 'sandbox' });
    const r1 = await requestOtp(app, demoPhone);
    expect(r1.status).toBe(200);
    expect(r1.body.demoOtp).toBeUndefined();
    if (h.notifications.lastCode(demoPhone) === '123456') return;
    const r2 = await verify(app, demoPhone, '123456');
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('OTP_INVALID');
  });

  it('rejected when DEMO_OTP_ENABLED=false', async () => {
    const app = h.appWith({ ...env, DEMO_OTP_ENABLED: 'false' });
    const r1 = await requestOtp(app, demoPhone);
    expect(r1.body.demoOtp).toBeUndefined();
    if (h.notifications.lastCode(demoPhone) === '123456') return;
    expect((await verify(app, demoPhone, '123456')).status).toBe(400);
  });
});
