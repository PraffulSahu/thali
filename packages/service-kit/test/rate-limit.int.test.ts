import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@thali/contracts';
import { consumeRateLimit, createApp, createRedis, rateLimit, type Redis } from '@thali/service-kit';
import { createTestConfig, createTestRedis, testLogger, type TestRedis } from '@thali/service-kit/testing';

let tr: TestRedis;
let app: ReturnType<typeof createApp>;
let dead: Redis;

beforeAll(async () => {
  tr = await createTestRedis();
  dead = createRedis('redis://127.0.0.1:1', {
    redisOptions: { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null },
  });
  app = createApp({
    config: createTestConfig(),
    logger: testLogger(),
    routes(a) {
      a.get(
        '/limited',
        rateLimit({ redis: tr.redis, name: 'test', keyFn: (req) => req.header('x-key') ?? 'anon', points: 3, durationSec: 10 }),
        (_req, res) => res.json({ ok: true }),
      );
      a.get(
        '/blocked',
        rateLimit({ redis: tr.redis, name: 'block', keyFn: () => 'one', points: 1, durationSec: 1, blockSec: 30 }),
        (_req, res) => res.json({ ok: true }),
      );
      a.get(
        '/skippable',
        rateLimit({ redis: tr.redis, name: 'skip', keyFn: () => null, points: 1, durationSec: 10 }),
        (_req, res) => res.json({ ok: true }),
      );
      a.get('/redis-down-default', rateLimit({ redis: dead, name: 'down', keyFn: () => 'k', points: 5, durationSec: 10 }), (_req, res) =>
        res.json({ ok: true }),
      );
      a.get(
        '/redis-down-open',
        rateLimit({ redis: dead, name: 'down', keyFn: () => 'k', points: 5, durationSec: 10, failOpen: true }),
        (_req, res) => res.json({ ok: true }),
      );
      a.get('/manual', () => {
        throw new DomainError('RATE_LIMITED', 'slow down', undefined, { retryAfterSec: 7 });
      });
    },
  });
});

afterAll(async () => {
  dead.disconnect();
  await tr.cleanup();
});

describe('rateLimit (fixed window)', () => {
  it('3 points / 10 s → 4th request is 429 with integer Retry-After and RATE_LIMITED envelope', async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/limited').set('x-key', 'k1');
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
      expect(ok.headers['ratelimit-remaining']).toBe(String(2 - i));
    }
    const res = await request(app).get('/limited').set('x-key', 'k1');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    const ra = Number(res.headers['retry-after']);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(10);
    expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', requestId: res.headers['x-request-id'] });
    expect(res.body.error.details).toEqual({ retryAfterSec: ra });
  });

  it('different keys are independent', async () => {
    for (let i = 0; i < 3; i++) expect((await request(app).get('/limited').set('x-key', 'k2')).status).toBe(200);
    expect((await request(app).get('/limited').set('x-key', 'k2')).status).toBe(429);
    expect((await request(app).get('/limited').set('x-key', 'k3')).status).toBe(200);
  });

  it('stores counters under the Redis key prefix', async () => {
    const keys = await tr.redis.keys(`${tr.prefix}rl:test:*`);
    expect(keys).toEqual(expect.arrayContaining([`${tr.prefix}rl:test:k1`, `${tr.prefix}rl:test:k2`]));
  });

  it('blockSec extends the lockout once the limit is exceeded', async () => {
    expect((await request(app).get('/blocked')).status).toBe(200);
    const res = await request(app).get('/blocked');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(25);
  });

  it('keyFn returning null skips limiting', async () => {
    for (let i = 0; i < 3; i++) expect((await request(app).get('/skippable')).status).toBe(200);
  });

  it('a thrown RATE_LIMITED DomainError with details.retryAfterSec sets Retry-After', async () => {
    const res = await request(app).get('/manual');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
  });

  it('consumeRateLimit is usable programmatically', async () => {
    const opts = { redis: tr.redis, key: 'otp:phone:+919000000001', points: 2, durationSec: 30 };
    expect(await consumeRateLimit(opts)).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(await consumeRateLimit(opts)).toMatchObject({ allowed: true, remaining: 0 });
    const third = await consumeRateLimit(opts);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(29);
    expect(await tr.redis.exists(`${tr.prefix}rl:otp:phone:+919000000001`)).toBe(1);
  });

  it('Redis down: fails CLOSED by default (503 SERVICE_UNAVAILABLE)', async () => {
    const res = await request(app).get('/redis-down-default');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('Redis down with failOpen:true lets the request through', async () => {
    const res = await request(app).get('/redis-down-open');
    expect(res.status).toBe(200);
  });
});
