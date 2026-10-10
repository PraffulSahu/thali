/** IDN-2 address locality, IDN-3 avatars, demo phone prefixes (contract 8). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { signServiceToken } from '@thali/service-kit';
import { TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import { loadIdentityConfig, demoOtpAllowed } from '../src/config.js';
import { baseEnv, bearer, createHarness, loginWithOtp, randomPhone, type Harness, type LoginResult } from './helpers.js';

let h: Harness;
let a: LoginResult;
let b: LoginResult;
beforeAll(async () => {
  h = await createHarness('profile_redesign');
  a = await loginWithOtp(h.app, h, randomPhone());
  b = await loginWithOtp(h.app, h, randomPhone());
});
afterAll(async () => {
  await h?.close();
});
const asA = () => bearer(a.accessToken);
const internal = async () => bearer(await signServiceToken('orders', 'identity', TEST_INTERNAL_SERVICE_SECRET));

describe('IDN-2 address locality + formattedAddress', () => {
  it('POST stores them, views return them (null when absent), PATCH updates and clears', async () => {
    const created = await request(h.app)
      .post('/api/v1/me/addresses')
      .set(asA())
      .send({
        label: 'Home',
        line1: '12th Main',
        locality: 'Indiranagar',
        formattedAddress: '12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038',
        city: 'Bengaluru',
        pincode: '560038',
        location: { lat: 12.9719, lng: 77.6412 },
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ locality: 'Indiranagar', formattedAddress: expect.stringContaining('HAL 2nd Stage') });

    const plain = await request(h.app)
      .post('/api/v1/me/addresses')
      .set(asA())
      .send({ line1: 'Office', city: 'Bengaluru', pincode: '560001', location: { lat: 12.97, lng: 77.59 } });
    expect(plain.body.locality).toBeNull();
    expect(plain.body.formattedAddress).toBeNull();

    const me = await request(h.app).get('/api/v1/me').set(asA());
    expect(me.body.addresses.find((x: { id: string }) => x.id === created.body.id).locality).toBe('Indiranagar');

    const patched = await request(h.app).patch(`/api/v1/me/addresses/${plain.body.id}`).set(asA()).send({ locality: 'MG Road' });
    expect(patched.body.locality).toBe('MG Road');
    const cleared = await request(h.app).patch(`/api/v1/me/addresses/${plain.body.id}`).set(asA()).send({ locality: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.locality).toBeNull();

    const tooLong = await request(h.app).patch(`/api/v1/me/addresses/${plain.body.id}`).set(asA()).send({ locality: 'x'.repeat(61) });
    expect(tooLong.status).toBe(400);
  });
});

describe('IDN-3 avatars', () => {
  it('GET /me and /internal/users/:id expose avatarUrl (null by default)', async () => {
    expect((await request(h.app).get('/api/v1/me').set(asA())).body.avatarUrl).toBeNull();
    const r = await request(h.app).get(`/internal/users/${a.userId}`).set(await internal());
    expect(r.status).toBe(200);
    expect(r.body.avatarUrl).toBeNull();
  });

  it('POST /me/uploads presigns a public PUT under users/<me>/avatars/ (IMAGE rule)', async () => {
    const r = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/png', sizeBytes: 1000 });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(new RegExp(`^users/${a.userId}/avatars/[0-9a-f-]{36}\\.png$`));
    expect(r.body.bucket).toBe('public');
    expect(r.body.upload).toMatchObject({ method: 'PUT', maxBytes: 2 * 1024 * 1024 });

    const bad = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/gif', sizeBytes: 1000 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('FILE_INVALID');
    const big = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/jpeg', sizeBytes: 2 * 1024 * 1024 + 1 });
    expect(big.status).toBe(422);
    expect((await request(h.app).post('/api/v1/me/uploads').send({ contentType: 'image/png', sizeBytes: 10 })).status).toBe(401);
  });

  it('PATCH /me {avatarKey}: verified upload → avatarUrl; replaced avatar is deleted; null clears', async () => {
    const p1 = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/png', sizeBytes: 100 });
    h.storage.put(p1.body.key);
    const r1 = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: p1.body.key });
    expect(r1.status).toBe(200);
    expect(r1.body.avatarUrl).toBe(`http://storage.test/thali-public/${p1.body.key}`);
    expect((await request(h.app).get(`/internal/users/${a.userId}`).set(await internal())).body.avatarUrl).toBe(r1.body.avatarUrl);

    const p2 = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/png', sizeBytes: 100 });
    h.storage.put(p2.body.key);
    const r2 = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: p2.body.key });
    expect(r2.body.avatarUrl).toContain(p2.body.key);
    expect(h.storage.deleted).toContain(p1.body.key);

    const r3 = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: null });
    expect(r3.status).toBe(200);
    expect(r3.body.avatarUrl).toBeNull();
    expect(h.storage.deleted).toContain(p2.body.key);
  });

  it('rejects: missing object, content that is not an image (object deleted), another user’s key, absolute URLs', async () => {
    const p = await request(h.app).post('/api/v1/me/uploads').set(asA()).send({ contentType: 'image/png', sizeBytes: 100 });
    const missing = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: p.body.key });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('FILE_INVALID');

    h.storage.put(p.body.key, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png');
    const fake = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: p.body.key });
    expect(fake.status).toBe(422);
    expect(h.storage.objects.has(p.body.key)).toBe(false);

    const pb = await request(h.app).post('/api/v1/me/uploads').set(bearer(b.accessToken)).send({ contentType: 'image/png', sizeBytes: 100 });
    h.storage.put(pb.body.key);
    const foreign = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey: pb.body.key });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('FILE_INVALID');

    for (const avatarKey of ['https://randomuser.me/api/portraits/men/1.jpg', 'http://evil.test/a.png', `//randomuser.me/x.jpg`, `users/${a.userId}/avatars/../../x.png`]) {
      const r = await request(h.app).patch('/api/v1/me').set(asA()).send({ avatarKey });
      expect(r.status, avatarKey).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await request(h.app).get('/api/v1/me').set(asA())).body.avatarUrl).toBeNull();
  });

  it('seed-written absolute https refs resolve only for EXTERNAL_IMAGE_HOSTS', async () => {
    const users = h.db.conn.collection('users');
    const id = new Types.ObjectId(b.userId);
    await users.updateOne({ _id: id }, { $set: { avatarKey: 'https://randomuser.me/api/portraits/women/44.jpg' } });
    const r = await request(h.app).get('/api/v1/me').set(bearer(b.accessToken));
    expect(r.body.avatarUrl).toBe('https://randomuser.me/api/portraits/women/44.jpg');

    await users.updateOne({ _id: id }, { $set: { avatarKey: 'https://evil.example/x.jpg' } });
    expect((await request(h.app).get('/api/v1/me').set(bearer(b.accessToken))).body.avatarUrl).toBeNull();

    const none = h.appWith({ EXTERNAL_IMAGE_HOSTS: 'none' });
    await users.updateOne({ _id: id }, { $set: { avatarKey: 'https://randomuser.me/api/portraits/women/44.jpg' } });
    expect((await request(none).get('/api/v1/me').set(bearer(b.accessToken))).body.avatarUrl).toBeNull();
    await users.updateOne({ _id: id }, { $set: { avatarKey: null } });
  });
});

describe('demo phone prefixes (contract 8)', () => {
  const env = (over: Record<string, string>) => ({ ...baseEnv('x:'), ...over });

  it('default prefixes in demo mode; none elsewhere; invalid prefixes rejected', () => {
    expect(loadIdentityConfig(env({ APP_MODE: 'demo' })).DEMO_PHONE_PREFIXES).toEqual(['+91900', '+91910', '+91920', '+91930']);
    expect(loadIdentityConfig(env({ APP_MODE: 'sandbox' })).DEMO_PHONE_PREFIXES).toEqual([]);
    expect(loadIdentityConfig(env({ APP_MODE: 'demo', DEMO_PHONE_PREFIXES: '+91955' })).DEMO_PHONE_PREFIXES).toEqual(['+91955']);
    expect(() => loadIdentityConfig(env({ DEMO_PHONE_PREFIXES: '91910' }))).toThrow(/DEMO_PHONE_PREFIXES/);
  });

  it('demoOtpAllowed: prefix match only in demo mode with DEMO_OTP_ENABLED', () => {
    const demo = loadIdentityConfig(env({ APP_MODE: 'demo', DEMO_OTP_ENABLED: 'true' }));
    expect(demoOtpAllowed(demo, '+919101234567')).toBe(true);
    expect(demoOtpAllowed(demo, '+919301234567')).toBe(true);
    expect(demoOtpAllowed(demo, '+919876543210')).toBe(false);
    expect(demoOtpAllowed({ ...demo, DEMO_OTP_ENABLED: false }, '+919101234567')).toBe(false);
    const sandbox = loadIdentityConfig(env({ APP_MODE: 'sandbox', DEMO_OTP_ENABLED: 'true', DEMO_PHONE_PREFIXES: '+91910' }));
    expect(demoOtpAllowed(sandbox, '+919101234567')).toBe(false);
  });

  it('a generated Bengaluru consumer (+91910…) signs in with 123456 and no SMS', async () => {
    const app = h.appWith({ APP_MODE: 'demo', DEMO_OTP_ENABLED: 'true', OTP_RESEND_COOLDOWN_SEC: '0' });
    const phone = `+91910${String(Date.now()).slice(-7)}`;
    const before = h.notifications.sent.length;
    const r1 = await request(app).post('/api/v1/auth/otp/request').send({ phone });
    expect(r1.status).toBe(200);
    expect(r1.body.demoOtp).toBe(true);
    expect(h.notifications.sent.length).toBe(before);
    const r2 = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code: '123456' });
    expect(r2.status).toBe(200);
    expect(r2.body.demoOtp).toBe(true);
  });

  it('production refuses DEMO_PHONE_PREFIXES', () => {
    expect(() =>
      loadIdentityConfig(env({ APP_MODE: 'production', INTERNAL_SERVICE_SECRET: 'x'.repeat(40), DEMO_PHONE_PREFIXES: '+91910' })),
    ).toThrow(/DEMO_PHONE_PREFIXES/);
  });
});
