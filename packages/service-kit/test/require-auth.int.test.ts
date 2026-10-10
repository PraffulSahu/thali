import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApp,
  createAuthVerifier,
  createRedis,
  requireAuth,
  revokeSession,
  signServiceToken,
} from '@thali/service-kit';
import {
  createTestConfig,
  createTestRedis,
  generateTestKeys,
  testLogger,
  type TestKeys,
  type TestRedis,
} from '@thali/service-kit/testing';

let keys: TestKeys;
let other: TestKeys;
let tr: TestRedis;
let app: ReturnType<typeof createApp>;
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  keys = await generateTestKeys();
  other = await generateTestKeys();
  tr = await createTestRedis();
  app = createApp({
    config: createTestConfig({ SERVICE_NAME: 'orders' }),
    logger: testLogger(),
    auth: createAuthVerifier({ jwks: keys.jwks, redis: tr.redis }),
    routes(a) {
      a.get('/me', requireAuth(), (req, res) => res.json(req.auth));
      a.get('/owner', requireAuth({ roles: ['RESTAURANT_OWNER'] }), (_req, res) => res.json({ ok: true }));
      a.get('/admin', requireAuth({ roles: ['ADMIN'], mfa: true }), (_req, res) => res.json({ ok: true }));
      a.get('/finance', requireAuth({ roles: ['ADMIN'], mfa: true, adminRoles: ['FINANCE'] }), (_req, res) =>
        res.json({ ok: true }),
      );
      a.get('/maybe', requireAuth({ optional: true }), (req, res) => res.json({ auth: req.auth ?? null }));
    },
  });
});

afterAll(async () => {
  await tr.cleanup();
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('requireAuth', () => {
  it('valid token → req.auth populated', async () => {
    const token = await keys.sign({ sub: 'u1', roles: ['CONSUMER'], sid: 's1', amr: ['otp'] });
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1', roles: ['CONSUMER'], sessionId: 's1', amr: ['otp'], adminRoles: [] });
  });

  it('missing / malformed Authorization → 401 UNAUTHENTICATED', async () => {
    for (const h of [undefined, 'Basic abc', 'Bearer', 'Bearer not.a.jwt']) {
      const r = request(app).get('/me');
      const res = await (h ? r.set('authorization', h) : r);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('expired token → 401 UNAUTHENTICATED', async () => {
    const token = await keys.sign({ iat: now() - 1000, exp: now() - 10 });
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('wrong key, wrong alg (HS256 service token) or wrong audience → 401', async () => {
    const wrongKey = await other.sign({});
    const hs = await signServiceToken('orders', 'orders', createTestConfig().INTERNAL_SERVICE_SECRET);
    const wrongAud = await keys.sign({ aud: 'mfa' });
    const wrongIss = await keys.sign({ iss: 'someone-else' });
    for (const t of [wrongKey, hs, wrongAud, wrongIss]) {
      const res = await request(app).get('/me').set(bearer(t));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('token missing required claims → 401', async () => {
    const token = await keys.sign({ roles: 'ADMIN' as never });
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(401);
  });

  it('token without sid → 401 UNAUTHENTICATED', async () => {
    const token = await keys.sign({ sid: undefined });
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('Redis down → 503 SERVICE_UNAVAILABLE (revocation check fails closed)', async () => {
    const dead = createRedis('redis://127.0.0.1:1', {
      redisOptions: { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null },
    });
    const a = createApp({
      config: createTestConfig(),
      logger: testLogger(),
      auth: createAuthVerifier({ jwks: keys.jwks, redis: dead }),
      routes(x) {
        x.get('/me', requireAuth(), (req, res) => res.json(req.auth));
      },
    });
    const res = await request(a)
      .get('/me')
      .set(bearer(await keys.sign({})));
    dead.disconnect();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('role missing → 403 FORBIDDEN', async () => {
    const token = await keys.sign({ roles: ['CONSUMER'] });
    const res = await request(app).get('/owner').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const ok = await request(app)
      .get('/owner')
      .set(bearer(await keys.sign({ roles: ['CONSUMER', 'RESTAURANT_OWNER'] })));
    expect(ok.status).toBe(200);
  });

  it('mfa:true without amr mfa → 403 MFA_REQUIRED; with mfa → 200', async () => {
    const pwdOnly = await keys.sign({ roles: ['CONSUMER', 'ADMIN'], amr: ['pwd'], adm: ['SUPER_ADMIN'] });
    const res = await request(app).get('/admin').set(bearer(pwdOnly));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    const mfa = await keys.sign({ roles: ['CONSUMER', 'ADMIN'], amr: ['pwd', 'mfa'], adm: ['OPS'] });
    expect((await request(app).get('/admin').set(bearer(mfa))).status).toBe(200);
  });

  it('adminRoles: needs a listed sub-role (SUPER_ADMIN always passes)', async () => {
    const ops = await keys.sign({ roles: ['ADMIN'], amr: ['pwd', 'mfa'], adm: ['OPS'] });
    const fin = await keys.sign({ roles: ['ADMIN'], amr: ['pwd', 'mfa'], adm: ['FINANCE'] });
    const sup = await keys.sign({ roles: ['ADMIN'], amr: ['pwd', 'mfa'], adm: ['SUPER_ADMIN'] });
    expect((await request(app).get('/finance').set(bearer(ops))).status).toBe(403);
    expect((await request(app).get('/finance').set(bearer(fin))).status).toBe(200);
    expect((await request(app).get('/finance').set(bearer(sup))).status).toBe(200);
  });

  it('revoked:sid:<sid> present in Redis (with key prefix) → 401 SESSION_REVOKED', async () => {
    const token = await keys.sign({ sid: 'sess-revoked-raw' });
    expect((await request(app).get('/me').set(bearer(token))).status).toBe(200);
    await tr.redis.set(`${tr.prefix}revoked:sid:sess-revoked-raw`, '1', 'EX', 60);
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('revokeSession() writes the same key with a 15 min TTL', async () => {
    const token = await keys.sign({ sid: 'sess-revoked-helper' });
    await revokeSession(tr.redis, 'sess-revoked-helper');
    const ttl = await tr.redis.ttl(`${tr.prefix}revoked:sid:sess-revoked-helper`);
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
    const res = await request(app).get('/me').set(bearer(token));
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('optional: no header passes anonymously, a bad token is still 401', async () => {
    const anon = await request(app).get('/maybe');
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ auth: null });
    const bad = await request(app).get('/maybe').set(bearer('x.y.z'));
    expect(bad.status).toBe(401);
    const ok = await request(app)
      .get('/maybe')
      .set(bearer(await keys.sign({ sub: 'u9' })));
    expect(ok.body.auth.userId).toBe('u9');
  });
});

describe('createAuthVerifier with a remote JWKS URL', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/broken') {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(keys.jwks));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('verifies tokens against keys fetched from JWKS_URL', async () => {
    const verifier = createAuthVerifier({ jwksUrl: url, redis: tr.redis });
    const ctx = await verifier.verify(await keys.sign({ sub: 'remote-user' }));
    expect(ctx.userId).toBe('remote-user');
    await expect(verifier.verify(await other.sign({}))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('createApp builds a verifier from config.JWKS_URL + redis when auth is not injected', async () => {
    const a = createApp({
      config: createTestConfig({ SERVICE_NAME: 'orders', JWKS_URL: url }),
      logger: testLogger(),
      redis: tr.redis,
      routes(x) {
        x.get('/me', requireAuth(), (req, res) => res.json(req.auth));
      },
    });
    const res = await request(a)
      .get('/me')
      .set(bearer(await keys.sign({ sub: 'cfg-user' })));
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('cfg-user');
  });

  it('JWKS endpoint unreachable or failing → 503 SERVICE_UNAVAILABLE (not 401)', async () => {
    const token = await keys.sign({});
    const unreachable = createAuthVerifier({ jwksUrl: 'http://127.0.0.1:1/.well-known/jwks.json', redis: tr.redis });
    await expect(unreachable.verify(token)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', httpStatus: 503 });
    const broken = createAuthVerifier({ jwksUrl: url.replace(/\/\.well-known\/jwks\.json$/, '/broken'), redis: tr.redis });
    await expect(broken.verify(token)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('createApp throws at construction when JWKS_URL is set but no redis/auth is given', () => {
    expect(() =>
      createApp({
        config: createTestConfig({ JWKS_URL: url }),
        logger: testLogger(),
        routes() {},
      }),
    ).toThrow(/redis/i);
  });
});
