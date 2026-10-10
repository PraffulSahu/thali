import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAuthVerifier, verifyServiceToken } from '@thali/service-kit';
import {
  createTestRedis,
  generateTestKeys,
  TEST_INTERNAL_SERVICE_SECRET,
  testLogger,
  type TestKeys,
  type TestRedis,
} from '@thali/service-kit/testing';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';
import { deadUrl, SERVICES, startUpstream, testGatewayConfig, type Upstream } from './helpers.js';

let tr: TestRedis;
let keys: TestKeys;
const ups: Record<string, Upstream> = {};
const tokenChecks: Record<string, { iss?: string; error?: string }> = {};
let app: Express;
let adminToken: string;

const detailsFor = (svc: string) => ({
  service: svc,
  mode: 'demo',
  mongo: 'up',
  redis: 'up',
  outboxPending: svc.length, // distinguishable per service: proves it is the upstream's real data
  outboxOldestAgeSec: null,
  consumerLag: { [`events.${svc}`]: 0 },
  deadLetters: 0,
  providerErrorsLastHour: 0,
  providerErrorsByProvider: {},
  checkedAt: '2026-10-10T00:00:00.000Z',
});

beforeAll(async () => {
  tr = await createTestRedis();
  keys = await generateTestKeys();
  for (const s of SERVICES) {
    if (s === 'delivery') continue; // delivery is DOWN (connection refused)
    if (s === 'notifications') {
      ups[s] = await startUpstream(s, () => {
        /* hangs: health must time out, not wait */
      });
      continue;
    }
    ups[s] = await startUpstream(s, async (req, res) => {
      try {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const caller = await verifyServiceToken(token, { secret: TEST_INTERNAL_SERVICE_SECRET, audience: s });
        tokenChecks[s] = { iss: caller.service };
      } catch (e) {
        tokenChecks[s] = { error: (e as Error).message };
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'bad token', requestId: 'x' } }));
        return;
      }
      if (req.url !== '/internal/health/details') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(s === 'payments' ? { ...detailsFor(s), redis: 'down' } : detailsFor(s)));
    });
  }
  const urls: Record<string, string> = Object.fromEntries(Object.entries(ups).map(([k, u]) => [k, u.url]));
  urls.delivery = await deadUrl();
  app = buildApp({
    config: testGatewayConfig(urls, { REDIS_KEY_PREFIX: tr.prefix, HEALTH_TIMEOUT_MS: '400' }),
    logger: testLogger('gateway'),
    redis: tr.redis,
    auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
  });
  adminToken = await keys.sign({ roles: ['CONSUMER', 'ADMIN'], amr: ['pwd', 'mfa'], adm: ['OPS'] });
});
afterAll(async () => {
  await Promise.all(Object.values(ups).map((u) => u.close()));
  await tr.cleanup();
});

describe('GET /api/v1/admin/health', () => {
  it('401 without a token', async () => {
    const res = await request(app).get('/api/v1/admin/health');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('403 for a non-admin (consumer / owner)', async () => {
    for (const roles of [['CONSUMER'], ['CONSUMER', 'RESTAURANT_OWNER']] as const) {
      const token = await keys.sign({ roles: [...roles], amr: ['otp'] });
      const res = await request(app).get('/api/v1/admin/health').set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('403 MFA_REQUIRED for an admin without the mfa factor', async () => {
    const token = await keys.sign({ roles: ['CONSUMER', 'ADMIN'], amr: ['pwd'] });
    const res = await request(app).get('/api/v1/admin/health').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
  });

  it('never proxies this path to identity even though identity owns /api/v1/admin/users', async () => {
    const before = ups.identity!.hits.filter((h) => h.url.startsWith('/api/v1/admin/health')).length;
    await request(app).get('/api/v1/admin/health').set('authorization', `Bearer ${adminToken}`);
    expect(ups.identity!.hits.filter((h) => h.url.startsWith('/api/v1/admin/health')).length).toBe(before);
  });

  it('aggregates real upstream data; unreachable/hanging services are reported down with an error, never fabricated', async () => {
    const t0 = Date.now();
    const res = await request(app).get('/api/v1/admin/health').set('authorization', `Bearer ${adminToken}`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2500); // fan-out is parallel and bounded by the timeout
    const { services, overall, gateway } = res.body;

    expect(Object.keys(services).sort()).toEqual([...SERVICES].sort());
    for (const s of ['identity', 'marketplace', 'orders']) {
      expect(services[s].status, s).toBe('up');
      expect(services[s].details).toEqual(detailsFor(s)); // exactly the upstream's payload
      expect(services[s].error).toBeUndefined();
      expect(typeof services[s].latencyMs).toBe('number');
    }
    // payments answered but reports its redis down -> degraded, with its real details
    expect(services.payments.status).toBe('degraded');
    expect(services.payments.details.redis).toBe('down');

    expect(services.delivery.status).toBe('down');
    expect(services.delivery.error).toEqual(expect.any(String));
    expect(services.delivery.errorCode).toBe('UPSTREAM_UNAVAILABLE');
    expect(services.delivery.details).toBeUndefined();

    expect(services.notifications.status).toBe('down');
    expect(services.notifications.errorCode).toBe('UPSTREAM_TIMEOUT');
    expect(services.notifications.details).toBeUndefined();

    // GW-1 explanations
    expect(services.identity).toMatchObject({ degradedReasons: [], summary: 'All checks passing', providers: {} });
    expect(services.payments.degradedReasons).toEqual(['redis unreachable']);
    expect(services.payments.providers).toEqual({ payment: 'up' });
    expect(services.delivery).toMatchObject({ degradedReasons: [], providers: {} });
    expect(services.delivery.summary).toMatch(/^Unreachable: /);

    expect(overall).toBe('degraded');
    expect(gateway).toMatchObject({ status: 'up', redis: 'up', mode: 'demo' });
    expect(new Date(res.body.checkedAt).getTime()).toBeGreaterThan(t0 - 1000);
  });

  it('calls each service with a gateway-issued service token addressed to that service', async () => {
    await request(app).get('/api/v1/admin/health').set('authorization', `Bearer ${adminToken}`);
    for (const s of ['identity', 'marketplace', 'orders', 'payments']) expect(tokenChecks[s], s).toEqual({ iss: 'gateway' });
  });

  it('a service that rejects the service token shows as down (not as a 401 to the admin)', async () => {
    const bad = await startUpstream('identity', (_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'x' } }));
    });
    try {
      const a = buildApp({
        config: testGatewayConfig({ identity: bad.url }, { REDIS_KEY_PREFIX: tr.prefix, HEALTH_TIMEOUT_MS: '400' }),
        logger: testLogger('gateway'),
        redis: tr.redis,
        auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
      });
      const res = await request(a).get('/api/v1/admin/health').set('authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.services.identity.status).toBe('down');
      expect(res.body.services.identity.errorCode).toBe('UPSTREAM_ERROR');
      expect(res.body.overall).toBe('down');
    } finally {
      await bad.close();
    }
  });
});

describe('GW-1: a failing provider is "provider failing", never "down"', () => {
  it('notifications reachable with SMTP errors → degraded, providers.email failing, summary carries the scrubbed message', async () => {
    const notif = await startUpstream('notifications', (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ...detailsFor('notifications'),
          providerErrorsLastHour: 12,
          providerErrorsByProvider: { mailpit: 12 },
          lastProviderErrors: { mailpit: { message: 'SMTP connect ECONNREFUSED 10.0.3.12:587', at: new Date().toISOString() } },
        }),
      );
    });
    try {
      const a = buildApp({
        config: testGatewayConfig({ ...Object.fromEntries(Object.entries(ups).map(([k, u]) => [k, u.url])), notifications: notif.url }, { REDIS_KEY_PREFIX: tr.prefix, HEALTH_TIMEOUT_MS: '400' }),
        logger: testLogger('gateway'),
        redis: tr.redis,
        auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
      });
      const res = await request(a).get('/api/v1/admin/health').set('authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const n = res.body.services.notifications;
      expect(n.status).toBe('degraded');
      expect(n.error).toBeUndefined();
      expect(n.providers).toEqual({ email: 'failing', sms: 'up' });
      expect(n.degradedReasons).toEqual(['email provider failing (12 errors in the last hour): SMTP connect ECONNREFUSED 10.0.3.12:587']);
      expect(n.summary).toBe('Email provider failing: SMTP connect ECONNREFUSED 10.0.3.12:587');
    } finally {
      await notif.close();
    }
  });
});

describe('GET /health/ready', () => {
  it('checks Redis (rate limits + revocation depend on it)', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { redis: 'up' } });
  });
});
