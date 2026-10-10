import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, createHarness, loginWithOtp, randomPhone, type Harness, type LoginResult } from './helpers.js';

let h: Harness;
let a: LoginResult;
let b: LoginResult;
beforeAll(async () => {
  h = await createHarness('me');
  a = await loginWithOtp(h.app, h, randomPhone());
  b = await loginWithOtp(h.app, h, randomPhone());
});
afterAll(async () => {
  await h?.close();
});

const addr = (over: Record<string, unknown> = {}) => ({
  label: 'Home',
  line1: '12 MG Road',
  city: 'Bengaluru',
  pincode: '560001',
  location: { lat: 12.9716, lng: 77.5946 },
  ...over,
});
const asA = () => bearer(a.accessToken);

describe('/me', () => {
  it('GET /me returns the profile; requires auth', async () => {
    expect((await request(h.app).get('/api/v1/me')).status).toBe(401);
    const r = await request(h.app).get('/api/v1/me').set(asA());
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(a.userId);
    expect(r.body.roles).toEqual(['CONSUMER']);
    expect(r.body.addresses).toEqual([]);
  });

  it('PATCH /me updates name and email; duplicate email → 409', async () => {
    const r = await request(h.app).patch('/api/v1/me').set(asA()).send({ name: 'Asha', email: 'asha@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Asha');
    expect(r.body.email).toBe('asha@example.com');
    const dup = await request(h.app).patch('/api/v1/me').set(bearer(b.accessToken)).send({ email: 'ASHA@example.com' });
    expect(dup.status).toBe(409);
    const bad = await request(h.app).patch('/api/v1/me').set(asA()).send({ roles: ['ADMIN'] });
    expect(bad.status).toBe(400);
  });
});

describe('/me/addresses', () => {
  it('CRUD + new default unsets the previous one', async () => {
    const c1 = await request(h.app).post('/api/v1/me/addresses').set(asA()).send(addr());
    expect(c1.status).toBe(201);
    expect(c1.body.isDefault).toBe(true); // first address becomes default
    expect(c1.body.location).toEqual({ lat: 12.9716, lng: 77.5946 });

    const c2 = await request(h.app).post('/api/v1/me/addresses').set(asA()).send(addr({ label: 'Work', isDefault: true }));
    expect(c2.status).toBe(201);
    expect(c2.body.isDefault).toBe(true);

    const list = await request(h.app).get('/api/v1/me/addresses').set(asA());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { id: string }) => x.id)).toEqual([c2.body.id]);

    const p = await request(h.app).patch(`/api/v1/me/addresses/${c1.body.id}`).set(asA()).send({ line1: '99 Brigade Rd', isDefault: true });
    expect(p.status).toBe(200);
    expect(p.body.line1).toBe('99 Brigade Rd');
    const list2 = (await request(h.app).get('/api/v1/me/addresses').set(asA())).body.items as { id: string; isDefault: boolean }[];
    expect(list2.filter((x) => x.isDefault).map((x) => x.id)).toEqual([c1.body.id]);

    const d = await request(h.app).delete(`/api/v1/me/addresses/${c1.body.id}`).set(asA());
    expect(d.status).toBe(204);
    const list3 = (await request(h.app).get('/api/v1/me/addresses').set(asA())).body.items as { id: string; isDefault: boolean }[];
    expect(list3).toHaveLength(1);
    expect(list3[0]!.isDefault).toBe(true); // remaining address promoted to default

    expect((await request(h.app).delete(`/api/v1/me/addresses/${c1.body.id}`).set(asA())).status).toBe(404);
  });

  it('validates the body (pincode, location)', async () => {
    const r = await request(h.app).post('/api/v1/me/addresses').set(asA()).send(addr({ pincode: '012' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('max 10 addresses', async () => {
    const tok = bearer(b.accessToken);
    for (let i = 0; i < 10; i++) {
      const r = await request(h.app).post('/api/v1/me/addresses').set(tok).send(addr({ label: `A${i}` }));
      expect(r.status).toBe(201);
    }
    const r = await request(h.app).post('/api/v1/me/addresses').set(tok).send(addr({ label: 'eleventh' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    const list = await request(h.app).get('/api/v1/me/addresses').set(tok);
    expect(list.body.items).toHaveLength(10);
  });

  it("user A cannot PATCH or DELETE user B's address (404)", async () => {
    const bAddr = (await request(h.app).get('/api/v1/me/addresses').set(bearer(b.accessToken))).body.items[0];
    const p = await request(h.app).patch(`/api/v1/me/addresses/${bAddr.id}`).set(asA()).send({ line1: 'hijack' });
    expect(p.status).toBe(404);
    const d = await request(h.app).delete(`/api/v1/me/addresses/${bAddr.id}`).set(asA());
    expect(d.status).toBe(404);
    const still = (await request(h.app).get('/api/v1/me/addresses').set(bearer(b.accessToken))).body.items[0];
    expect(still.line1).toBe('12 MG Road');
  });
});

describe('/me/notification-prefs', () => {
  it('PUT saves prefs and GET /me reflects them', async () => {
    const prefs = { orderSms: false, orderEmail: true, marketingSms: true, marketingEmail: false };
    const r = await request(h.app).put('/api/v1/me/notification-prefs').set(asA()).send(prefs);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(prefs);
    const me = await request(h.app).get('/api/v1/me').set(asA());
    expect(me.body.notificationPrefs).toEqual(prefs);
    const bad = await request(h.app).put('/api/v1/me/notification-prefs').set(asA()).send({ orderSms: 'yes' });
    expect(bad.status).toBe(400);
  });
});
