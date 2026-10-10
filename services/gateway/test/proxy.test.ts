import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testLogger } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { PREFIX_MAP, resolveService } from '../src/routes-map.js';
import { deadUrl, SERVICES, startUpstream, testGatewayConfig, type Upstream } from './helpers.js';

const upstreams: Record<string, Upstream> = {};
let app: Express;

beforeAll(async () => {
  for (const s of SERVICES) upstreams[s] = await startUpstream(s);
  const urls = Object.fromEntries(SERVICES.map((s) => [s, upstreams[s]!.url]));
  app = buildApp({
    config: testGatewayConfig(urls, { CORS_ORIGINS: 'http://localhost:5173', TRUST_PROXY: 'false' }),
    logger: testLogger('gateway'),
  });
});
afterAll(async () => {
  await Promise.all(Object.values(upstreams).map((u) => u.close()));
});

const hitsOf = (svc: string) => upstreams[svc]!.hits;

describe('prefix map (HLD 3.1)', () => {
  it.each([
    ['/api/v1/auth/otp/request', 'identity'],
    ['/api/v1/me', 'identity'],
    ['/api/v1/me/addresses', 'identity'],
    ['/api/v1/admin/users', 'identity'],
    ['/api/v1/admin/audit-logs', 'identity'],
    ['/.well-known/jwks.json', 'identity'],
    ['/api/v1/discovery/restaurants', 'marketplace'],
    ['/api/v1/restaurants/abc', 'marketplace'],
    ['/api/v1/owner/restaurants/1/items', 'marketplace'],
    ['/api/v1/admin/marketplace/restaurants', 'marketplace'],
    ['/api/v1/cart/items', 'orders'],
    ['/api/v1/owner/orders/1/accept', 'orders'],
    ['/api/v1/admin/orders', 'orders'],
    ['/api/v1/admin/support/tickets', 'orders'],
    ['/api/v1/webhooks/razorpay', 'payments'],
    ['/api/v1/admin/finance/refunds', 'payments'],
    ['/api/v1/demo-pay/x', 'payments'],
    ['/api/v1/partner/profile', 'delivery'],
    ['/api/v1/admin/delivery/jobs', 'delivery'],
    ['/api/v1/realtime/stream', 'notifications'],
    ['/api/v1/webhooks/twilio/status', 'notifications'],
    ['/api/v1/webhooks/resend', 'notifications'],
    ['/api/v1/meta', 'gateway'],
    ['/api/v1/admin/health', 'gateway'],
    ['/api/docs/specs/identity.json', 'gateway'],
  ])('%s -> %s', (path, svc) => {
    expect(resolveService(path)).toBe(svc);
  });

  it('matches on segment boundaries only', () => {
    expect(resolveService('/api/v1/message')).toBeNull();
    expect(resolveService('/api/v1/meta2')).toBeNull();
    expect(resolveService('/api/v1/webhooks')).toBeNull();
    expect(resolveService('/api/v1/webhooks/stripe')).toBeNull();
    expect(resolveService('/internal/users/1')).toBeNull();
    expect(resolveService('/api/v1/internal/users/1')).toBeNull();
  });

  it('longest prefix wins over a shorter overlapping prefix', () => {
    const map = [
      ['/api/v1/admin', 'identity'],
      ['/api/v1/admin/marketplace', 'marketplace'],
    ] as const;
    expect(resolveService('/api/v1/admin/marketplace/x', map)).toBe('marketplace');
    expect(resolveService('/api/v1/admin/marketplace', map)).toBe('marketplace');
    expect(resolveService('/api/v1/admin/users', map)).toBe('identity');
  });

  it('the table has no duplicate prefixes', () => {
    const prefixes = PREFIX_MAP.map(([p]) => p);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('proxy routing', () => {
  it('routes /api/v1/admin/marketplace/x to marketplace, not identity', async () => {
    const before = hitsOf('identity').length;
    const res = await request(app).get('/api/v1/admin/marketplace/x?y=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ service: 'marketplace', method: 'GET', url: '/api/v1/admin/marketplace/x?y=1' });
    expect(hitsOf('identity').length).toBe(before);
  });

  it('forwards method, path and query string untouched', async () => {
    const res = await request(app).put('/api/v1/owner/restaurants/7/hours?a=1&a=2&b=%20x');
    expect(res.body).toEqual({ service: 'marketplace', method: 'PUT', url: '/api/v1/owner/restaurants/7/hours?a=1&a=2&b=%20x' });
  });

  it('never proxies /internal/* (404 envelope, nothing reaches any upstream)', async () => {
    const counts = SERVICES.map((s) => hitsOf(s).length);
    for (const path of ['/internal/users/1', '/internal/health/details', '/api/v1/internal/users/1']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.requestId).toBeTruthy();
    }
    const post = await request(app).post('/internal/payment-intents').send({});
    expect(post.status).toBe(404);
    expect(SERVICES.map((s) => hitsOf(s).length)).toEqual(counts);
  });

  it('404 envelope for unknown /api/v1 prefixes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects dot-segment / backslash tricks (400) without proxying', async () => {
    const before = SERVICES.map((s) => hitsOf(s).length);
    for (const path of ['/api/v1/me/../../../internal/users/1', '/api/v1/me/%2e%2e/%2E%2e/internal', '/api/v1/me/.%2e/x', '/api/v1/me/%5Cx']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(SERVICES.map((s) => hitsOf(s).length)).toEqual(before);
  });
});

describe('raw body passthrough (Review Focus #3)', () => {
  // Whitespace / key order / unicode / escapes that any JSON re-serialization would change.
  const raw = Buffer.from('{ "event" :"payment.captured",\n\t"amount":  50000, "note":"café \\u00e9 ₹", "b":[1,  2 ,3] }  \n', 'utf8');
  const signature = 'sha256=3f1c9b2e7a5d4c6b8a9e0f1d2c3b4a5968778695a4b3c2d1e0f';

  it('delivers byte-identical bytes and the signature header to payments', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(raw.toString('utf8')); // superagent JSON-encodes Buffers; a string goes out verbatim
    expect(res.status).toBe(200);
    const hit = hitsOf('payments').at(-1)!;
    expect(hit.url).toBe('/api/v1/webhooks/razorpay');
    expect(Buffer.compare(hit.body, raw)).toBe(0);
    expect(hit.headers['x-razorpay-signature']).toBe(signature);
    expect(hit.headers['content-type']).toBe('application/json');
  });

  it('delivers arbitrary binary bytes unchanged (all 256 values, 1 MiB+)', async () => {
    const bin = Buffer.alloc(1_200_000);
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + (i >> 8)) & 0xff;
    const res = await request(app).post('/api/v1/webhooks/twilio/status').set('content-type', 'application/octet-stream').send(bin);
    expect(res.status).toBe(200);
    expect(Buffer.compare(hitsOf('notifications').at(-1)!.body, bin)).toBe(0);
  });

  it('also holds for chunked client bodies (no content-length)', async () => {
    const port = ((server.address() as AddressInfo).port);
    const chunks = [raw.subarray(0, 7), raw.subarray(7, 30), raw.subarray(30)];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/v1/webhooks/razorpay', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      for (const c of chunks) req.write(c);
      req.end();
    });
    const hit = hitsOf('payments').at(-1)!;
    expect(Buffer.compare(hit.body, raw)).toBe(0);
  });

  it('does not parse or reject malformed JSON itself (the service owns validation)', async () => {
    const res = await request(app).post('/api/v1/cart/items').set('content-type', 'application/json').send('{not json');
    expect(res.status).toBe(200);
    expect(hitsOf('orders').at(-1)!.body.toString()).toBe('{not json');
  });
});

describe('request id & forwarding headers', () => {
  it('generates a request id, forwards it upstream and echoes it', async () => {
    const res = await request(app).get('/api/v1/cuisines');
    const sent = hitsOf('marketplace').at(-1)!.headers['x-request-id'];
    expect(sent).toMatch(/^[A-Za-z0-9._:-]{8,}$/);
    expect(res.headers['x-request-id']).toBe(sent);
  });

  it('keeps a well-formed inbound id', async () => {
    await request(app).get('/api/v1/cuisines').set('x-request-id', 'client-req-123');
    expect(hitsOf('marketplace').at(-1)!.headers['x-request-id']).toBe('client-req-123');
  });

  it('sets x-forwarded-* and does not trust client-supplied ones', async () => {
    await request(app)
      .get('/api/v1/cuisines')
      .set('x-forwarded-for', '6.6.6.6')
      .set('x-forwarded-host', 'evil.test')
      .set('x-forwarded-proto', 'https')
      .set('host', 'api.thali.test');
    const h = hitsOf('marketplace').at(-1)!.headers;
    expect(String(h['x-forwarded-for'])).not.toContain('6.6.6.6');
    expect(h['x-forwarded-for']).toMatch(/127\.0\.0\.1/);
    expect(h['x-forwarded-proto']).toBe('http');
    expect(h['x-forwarded-host']).toBe('api.thali.test');
    // upstream sees its own host, not the public one
    expect(h.host).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('behind one trusted proxy (TRUST_PROXY=1) forwards the real client ip it resolved', async () => {
    const urls = Object.fromEntries(SERVICES.map((s) => [s, upstreams[s]!.url]));
    const a = buildApp({ config: testGatewayConfig(urls, { TRUST_PROXY: '1' }), logger: testLogger('gateway') });
    await request(a).get('/api/v1/cuisines').set('x-forwarded-for', '203.0.113.9').set('x-forwarded-proto', 'https').set('x-forwarded-host', 'thali.example');
    const h = hitsOf('marketplace').at(-1)!.headers;
    expect(h['x-forwarded-for']).toBe('203.0.113.9');
    expect(h['x-forwarded-proto']).toBe('https');
    expect(h['x-forwarded-host']).toBe('thali.example');
  });

  it('passes the Authorization header and strips hop-by-hop request headers', async () => {
    await request(app)
      .get('/api/v1/me')
      .set('authorization', 'Bearer abc.def.ghi')
      .set('keep-alive', 'timeout=5')
      .set('te', 'trailers')
      .set('proxy-authorization', 'Basic xx')
      .set('connection', 'keep-alive, x-secret-hop')
      .set('x-secret-hop', 'drop-me');
    const h = hitsOf('identity').at(-1)!.headers;
    expect(h.authorization).toBe('Bearer abc.def.ghi');
    expect(h['keep-alive']).toBeUndefined();
    expect(h.te).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
    expect(h['x-secret-hop']).toBeUndefined();
  });
});

describe('response passthrough', () => {
  it('copies status, headers, multiple cookies and body; strips hop-by-hop + upstream CORS', async () => {
    const u = await startUpstream('identity', (_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2; Path=/']);
      res.setHeader('x-custom', 'yes');
      res.setHeader('keep-alive', 'timeout=5');
      res.setHeader('access-control-allow-origin', 'http://evil.test');
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'nope', requestId: 'r' } }));
    });
    try {
      const a = buildApp({
        config: testGatewayConfig({ identity: u.url }, { CORS_ORIGINS: 'http://localhost:5173' }),
        logger: testLogger('gateway'),
      });
      const res = await request(a).get('/api/v1/me').set('origin', 'http://localhost:5173');
      expect(res.status).toBe(401); // identity's real 401 reaches the browser (not mapped to 502)
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.headers['x-custom']).toBe('yes');
      expect(res.headers['set-cookie']).toEqual(['a=1; HttpOnly', 'b=2; Path=/']);
      expect(res.headers['keep-alive']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    } finally {
      await u.close();
    }
  });

  it('streams big responses without alteration', async () => {
    const payload = Buffer.alloc(3_000_000, 'abc');
    const u = await startUpstream('marketplace', (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(payload);
    });
    try {
      const a = buildApp({ config: testGatewayConfig({ marketplace: u.url }), logger: testLogger('gateway') });
      const res = await request(a).get('/api/v1/cuisines').buffer(true).parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      });
      expect(Buffer.compare(res.body as Buffer, payload)).toBe(0);
    } finally {
      await u.close();
    }
  });
});

describe('upstream failures', () => {
  it('connection refused -> 502 UPSTREAM_UNAVAILABLE envelope', async () => {
    const a = buildApp({ config: testGatewayConfig({ orders: await deadUrl() }), logger: testLogger('gateway') });
    const res = await request(a).get('/api/v1/cart');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('upstream that never answers -> 504 UPSTREAM_TIMEOUT after UPSTREAM_TIMEOUT_MS', async () => {
    const u = await startUpstream('orders', () => {
      /* never respond */
    });
    try {
      const a = buildApp({ config: testGatewayConfig({ orders: u.url }, { UPSTREAM_TIMEOUT_MS: '300' }), logger: testLogger('gateway') });
      const t0 = Date.now();
      const res = await request(a).get('/api/v1/cart');
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await u.close();
    }
  });

  it('upstream that dies mid-request -> 502', async () => {
    const u = await startUpstream('orders', (req) => req.socket.destroy());
    try {
      const a = buildApp({ config: testGatewayConfig({ orders: u.url }), logger: testLogger('gateway') });
      const res = await request(a).get('/api/v1/cart');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      await u.close();
    }
  });

  it('default upstream timeout is 15 s', () => {
    expect(testGatewayConfig().UPSTREAM_TIMEOUT_MS).toBe(15_000);
  });
});

describe('CORS (handled at the gateway)', () => {
  it('answers preflight itself with credentials, without hitting the upstream', async () => {
    const before = hitsOf('orders').length;
    const res = await request(app)
      .options('/api/v1/checkouts')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'authorization,idempotency-key,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toMatch(/idempotency-key/i);
    expect(hitsOf('orders').length).toBe(before);
  });

  it('adds credentialed CORS headers to proxied responses for allowed origins only', async () => {
    const ok = await request(app).get('/api/v1/cuisines').set('origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-expose-headers']).toMatch(/x-request-id/i);
    const bad = await request(app).get('/api/v1/cuisines').set('origin', 'http://evil.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// A live server for the chunked-body test above.
let server: Server;
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
