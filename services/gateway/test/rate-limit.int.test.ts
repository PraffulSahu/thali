import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRedis, type Redis } from '@thali/service-kit';
import { createTestRedis, testLogger, type TestRedis } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { SERVICES, startUpstream, testGatewayConfig, type Upstream } from './helpers.js';

let tr: TestRedis;
let identity: Upstream;
let marketplace: Upstream;
let orders: Upstream;

beforeAll(async () => {
  tr = await createTestRedis();
  identity = await startUpstream('identity');
  marketplace = await startUpstream('marketplace');
  orders = await startUpstream('orders');
});
afterAll(async () => {
  await Promise.all([identity.close(), marketplace.close(), orders.close()]);
  await Promise.all(clients.map((c) => c.quit()));
  await tr.cleanup();
});

const clients: Redis[] = [];
/** A gateway with its own key namespace, so tests never share rate-limit counters. */
const gateway = (env: Record<string, string> = {}, redis?: Redis) => {
  const own = redis ?? createRedis(tr.url, { keyPrefix: `${tr.prefix}${clients.length}:` });
  if (!redis) clients.push(own);
  return buildApp({
    config: testGatewayConfig({ identity: identity.url, marketplace: marketplace.url, orders: orders.url }, env),
    logger: testLogger('gateway'),
    redis: own,
  });
};

describe('rate limits (LLD 5.4)', () => {
  it('OTP: 10/min/IP — the 11th request in a minute is 429 and never reaches identity', async () => {
    const app = gateway();
    const before = identity.hits.length;
    for (let i = 1; i <= 10; i++) {
      const res = await request(app).post('/api/v1/auth/otp/request').send({ phone: '9876543210' });
      expect(res.status, `request ${i}`).toBe(200);
    }
    const res = await request(app).post('/api/v1/auth/otp/request').send({ phone: '9876543210' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.requestId).toBeTruthy();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(identity.hits.length - before).toBe(10);
    // verify endpoint shares the /auth/otp/* limiter
    const verify = await request(app).post('/api/v1/auth/otp/verify').send({});
    expect(verify.status).toBe(429);
    // other identity routes are not under the OTP limiter
    expect((await request(app).get('/api/v1/me')).status).toBe(200);
  });

  it('admin password forgot/reset share a fail-closed per-IP limiter (like OTP); admin login is unaffected', async () => {
    const app = gateway({ RATE_LIMIT_ADMIN_PASSWORD_PER_MIN: '3' });
    const before = identity.hits.length;
    for (let i = 1; i <= 2; i++) {
      expect((await request(app).post('/api/v1/auth/admin/password/forgot').send({ email: 'a@b.co' })).status, `forgot ${i}`).toBe(200);
    }
    expect((await request(app).post('/api/v1/auth/admin/password/reset').send({})).status).toBe(200);
    const res = await request(app).post('/api/v1/auth/admin/password/forgot').send({ email: 'a@b.co' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(identity.hits.length - before).toBe(3);
    // proxied to identity unchanged (prefix /api/v1/auth), login not under this limiter
    expect(identity.hits.at(-1)!.url).toBe('/api/v1/auth/admin/password/reset');
    expect((await request(app).post('/api/v1/auth/admin/login').send({})).status).toBe(200);
  });

  it('discovery: 60/min/IP — the 61st is 429', async () => {
    const app = gateway();
    for (let i = 1; i <= 60; i++) {
      const res = await request(app).get('/api/v1/discovery/restaurants?lat=1&lng=2');
      expect(res.status, `request ${i}`).toBe(200);
    }
    const res = await request(app).get('/api/v1/discovery/search?q=biryani');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // restaurants (not discovery) is unaffected
    expect((await request(app).get('/api/v1/restaurants/abc')).status).toBe(200);
  });

  it('address search (places autocomplete / details, reverse geocode) has its own larger bucket, separate from discovery', async () => {
    const app = gateway({ RATE_LIMIT_DISCOVERY_PER_MIN: '3', RATE_LIMIT_PLACES_PER_MIN: '5' });
    for (let i = 1; i <= 3; i++) expect((await request(app).get('/api/v1/discovery/restaurants?lat=1&lng=2')).status, `discovery ${i}`).toBe(200);
    expect((await request(app).get('/api/v1/discovery/restaurants?lat=1&lng=2')).status).toBe(429);
    // discovery exhausted: address search still works, on its own bucket
    const paths = ['/api/v1/discovery/places?q=indira', '/api/v1/discovery/places/abc123', '/api/v1/discovery/reverse?lat=1&lng=2', '/api/v1/discovery/places?q=kora', '/api/v1/discovery/reverse?lat=3&lng=4'];
    for (const p of paths) expect((await request(app).get(p)).status, p).toBe(200);
    const res = await request(app).get('/api/v1/discovery/places?q=hsr');
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('5');
  });

  it('address search does not consume the discovery bucket', async () => {
    const app = gateway({ RATE_LIMIT_DISCOVERY_PER_MIN: '2', RATE_LIMIT_PLACES_PER_MIN: '50' });
    for (let i = 0; i < 10; i++) expect((await request(app).get('/api/v1/discovery/places?q=x')).status).toBe(200);
    expect((await request(app).get('/api/v1/discovery/restaurants?lat=1&lng=2')).status).toBe(200);
    expect((await request(app).get('/api/v1/discovery/search?q=dosa')).status).toBe(200);
    expect((await request(app).get('/api/v1/discovery/serviceability?lat=1&lng=2')).status).toBe(429);
  });

  it('global: limited per IP across all routes (configurable, default 300)', async () => {
    const app = gateway({ RATE_LIMIT_GLOBAL_PER_MIN: '5' });
    for (let i = 1; i <= 5; i++) expect((await request(app).get('/api/v1/cart')).status).toBe(200);
    const res = await request(app).get('/api/v1/cuisines');
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('5');
    // health probes are not rate limited
    expect((await request(app).get('/health/live')).status).toBe(200);
  });

  it('limits are per IP (client ip behind a trusted proxy)', async () => {
    const app = gateway({ RATE_LIMIT_GLOBAL_PER_MIN: '2', TRUST_PROXY: '1' });
    const get = (ip: string) => request(app).get('/api/v1/cart').set('x-forwarded-for', ip);
    expect((await get('10.0.0.1')).status).toBe(200);
    expect((await get('10.0.0.1')).status).toBe(200);
    expect((await get('10.0.0.1')).status).toBe(429);
    expect((await get('10.0.0.2')).status).toBe(200);
  });

  it('default limits are exactly 300 / 60 / 10, address search 180', () => {
    const c = testGatewayConfig();
    expect([c.RATE_LIMIT_GLOBAL_PER_MIN, c.RATE_LIMIT_DISCOVERY_PER_MIN, c.RATE_LIMIT_OTP_PER_MIN]).toEqual([300, 60, 10]);
    expect(c.RATE_LIMIT_PLACES_PER_MIN).toBe(180);
  });

  describe('when Redis is down', () => {
    const broken = () =>
      createRedis('redis://127.0.0.1:1', {
        redisOptions: { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null },
      });

    it('global and discovery limiters fail OPEN (traffic keeps flowing)', async () => {
      const redis = broken();
      try {
        const app = gateway({}, redis);
        expect((await request(app).get('/api/v1/cuisines')).status).toBe(200);
        expect((await request(app).get('/api/v1/discovery/restaurants')).status).toBe(200);
      } finally {
        redis.disconnect();
      }
    });

    it('OTP limiter fails CLOSED (503, request not proxied)', async () => {
      const redis = broken();
      try {
        const app = gateway({}, redis);
        const before = identity.hits.length;
        const res = await request(app).post('/api/v1/auth/otp/request').send({ phone: '9876543210' });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(identity.hits.length).toBe(before);
      } finally {
        redis.disconnect();
      }
    });
  });

  it('upstream list sanity', () => {
    expect(SERVICES).toHaveLength(6);
  });
});
