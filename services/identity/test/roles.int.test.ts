import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signServiceToken } from '@thali/service-kit';
import { TEST_INTERNAL_SERVICE_SECRET } from '@thali/service-kit/testing';
import type { ServiceName } from '@thali/contracts';
import { bearer, createHarness, isRevoked, loginWithOtp, randomPhone, withCsrf, type Harness, type LoginResult } from './helpers.js';

let h: Harness;
let u: LoginResult;
beforeAll(async () => {
  h = await createHarness('roles');
  u = await loginWithOtp(h.app, h, randomPhone());
});
afterAll(async () => {
  await h?.close();
});

const svc = async (from: ServiceName) => bearer(await signServiceToken(from, 'identity', TEST_INTERNAL_SERVICE_SECRET));
const grant = async (userId: string, role: string, from: ServiceName = 'marketplace') =>
  request(h.app).post(`/internal/users/${userId}/roles`).set(await svc(from)).send({ role });

describe('POST /internal/users/:id/roles', () => {
  it('marketplace grants RESTAURANT_OWNER → 200 {userId, roles} + role.granted event', async () => {
    const r = await grant(u.userId, 'RESTAURANT_OWNER', 'marketplace');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ userId: u.userId, roles: ['CONSUMER', 'RESTAURANT_OWNER'] });
    const events = await h.db.conn
      .collection('outbox')
      .find({ 'envelope.type': 'role.granted', 'envelope.payload.userId': u.userId })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.envelope.payload).toEqual({ userId: u.userId, role: 'RESTAURANT_OWNER' });
    expect(events[0]!.stream).toBe('events.identity');
  });

  it('is idempotent (second grant: same roles, no second event)', async () => {
    const r = await grant(u.userId, 'RESTAURANT_OWNER', 'marketplace');
    expect(r.status).toBe(200);
    expect(r.body.roles).toEqual(['CONSUMER', 'RESTAURANT_OWNER']);
    const count = await h.db.conn
      .collection('outbox')
      .countDocuments({ 'envelope.type': 'role.granted', 'envelope.payload.userId': u.userId, 'envelope.payload.role': 'RESTAURANT_OWNER' });
    expect(count).toBe(1);
  });

  it('delivery grants DELIVERY_PARTNER', async () => {
    const r = await grant(u.userId, 'DELIVERY_PARTNER', 'delivery');
    expect(r.status).toBe(200);
    expect(r.body.roles).toEqual(['CONSUMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER']);
  });

  it('a service outside the allow-list → 403', async () => {
    const r = await grant(u.userId, 'RESTAURANT_OWNER', 'orders');
    expect(r.status).toBe(403);
  });

  it('a user token → 401; no token → 401', async () => {
    const r = await request(h.app).post(`/internal/users/${u.userId}/roles`).set(bearer(u.accessToken)).send({ role: 'RESTAURANT_OWNER' });
    expect(r.status).toBe(401);
    const none = await request(h.app).post(`/internal/users/${u.userId}/roles`).send({ role: 'RESTAURANT_OWNER' });
    expect(none.status).toBe(401);
  });

  it('ADMIN cannot be granted through this route → 400', async () => {
    const r = await grant(u.userId, 'ADMIN');
    expect(r.status).toBe(400);
  });

  it('unknown user → 404', async () => {
    expect((await grant('64b7f0f0f0f0f0f0f0f0f0f0', 'RESTAURANT_OWNER')).status).toBe(404);
    expect((await grant('not-an-id', 'RESTAURANT_OWNER')).status).toBe(404);
  });

  it('a refreshed access token carries the granted role', async () => {
    const r = await withCsrf(request(h.app).post('/api/v1/auth/refresh')).set('Cookie', u.cookie);
    expect(r.status).toBe(200);
    expect(r.body.user.roles).toEqual(['CONSUMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER']);
  });
});

describe('GET /internal/users/:id', () => {
  it('returns exactly the binding shape', async () => {
    const r = await request(h.app).get(`/internal/users/${u.userId}`).set(await svc('notifications'));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['avatarUrl', 'email', 'id', 'name', 'notificationPrefs', 'phone', 'roles', 'status']);
    expect(r.body.id).toBe(u.userId);
    expect(r.body.avatarUrl).toBeNull(); // contract 5 (IDN-3)
    expect(r.body.email).toBeNull();
    expect(r.body.name).toBeNull();
    expect(r.body.status).toBe('ACTIVE');
    expect(r.body.notificationPrefs).toEqual({ orderSms: true, orderEmail: true, marketingSms: false, marketingEmail: false });
  });

  it('404 for unknown; 401 without service token; callers allowed: notifications, delivery, marketplace, orders', async () => {
    expect((await request(h.app).get('/internal/users/64b7f0f0f0f0f0f0f0f0f0f0').set(await svc('orders'))).status).toBe(404);
    expect((await request(h.app).get(`/internal/users/${u.userId}`)).status).toBe(401);
    for (const s of ['delivery', 'marketplace', 'orders'] as const) {
      expect((await request(h.app).get(`/internal/users/${u.userId}`).set(await svc(s))).status).toBe(200);
    }
    expect((await request(h.app).get(`/internal/users/${u.userId}`).set(await svc('payments'))).status).toBe(403);
  });
});

describe('POST /internal/users/:id/revoke-sessions', () => {
  it('revokes all sessions → 204', async () => {
    const other = await loginWithOtp(h.app, h, randomPhone());
    const r = await request(h.app).post(`/internal/users/${other.userId}/revoke-sessions`).set(await svc('delivery'));
    expect(r.status).toBe(204);
    expect(await isRevoked(h, other.sid)).toBe(true);
    const rf = await withCsrf(request(h.app).post('/api/v1/auth/refresh')).set('Cookie', other.cookie);
    expect(rf.status).toBe(401);
    expect((await request(h.app).post(`/internal/users/${other.userId}/revoke-sessions`).set(await svc('orders'))).status).toBe(403);
  });
});
