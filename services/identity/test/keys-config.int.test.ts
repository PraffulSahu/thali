import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { decodeProtectedHeader } from 'jose';
import { createAuthVerifier, createRedis } from '@thali/service-kit';
import { testLogger } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { loadIdentityConfig } from '../src/config.js';
import { loadSigningKeys } from '../src/domain/tokens.js';
import { baseEnv, createHarness, FakeNotifications, FakeOrders, randomPhone, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('keys_config');
});
afterAll(async () => {
  await h?.close();
});

const env = (over: Record<string, string> = {}) => ({ ...baseEnv(h.tr.prefix), ...over });

describe('signing keys', () => {
  it('demo without JWT_PRIVATE_KEY_PEM: generates once, persists encrypted in signing_keys, reuses on next boot', async () => {
    const again = await loadSigningKeys(h.db.conn, h.config);
    expect(again.kid).toBe(h.keys.kid);
    const docs = await h.db.conn.collection('signing_keys').find().toArray();
    expect(docs).toHaveLength(1);
    expect(String(docs[0]!.privateKeyEnc).startsWith('v1:')).toBe(true);
    expect(JSON.stringify(docs[0])).not.toContain('PRIVATE KEY');
    const token = await again.signAccessToken({ sub: 'u1', roles: ['CONSUMER'], sid: 's1', amr: ['otp'] });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'EdDSA', kid: h.keys.kid });
  });

  it('JWT_PRIVATE_KEY_PEM: used as-is (kid = thumbprint or JWT_KID) and verifiable via JWKS', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const ks = await loadSigningKeys(h.db.conn, loadIdentityConfig(env({ JWT_PRIVATE_KEY_PEM: pem, JWT_PUBLIC_KEY_PEM: pub })));
    expect(ks.kid).not.toBe(h.keys.kid);
    const token = await ks.signAccessToken({ sub: 'u1', roles: ['CONSUMER'], sid: 's1', amr: ['otp'] });
    const ctx = await createAuthVerifier({ jwks: ks.jwks(), redis: h.tr.redis }).verify(token);
    expect(ctx.userId).toBe('u1');
    const named = await loadSigningKeys(h.db.conn, loadIdentityConfig(env({ JWT_PRIVATE_KEY_PEM: pem, JWT_KID: 'k-2026' })));
    expect(named.kid).toBe('k-2026');
    // escaped newlines (single-line env) are accepted
    const oneLine = await loadSigningKeys(h.db.conn, loadIdentityConfig(env({ JWT_PRIVATE_KEY_PEM: pem.replace(/\n/g, '\\n') })));
    expect(oneLine.kid).toBe(ks.kid);
  });

  it('rejects a mismatched public key and non-Ed25519 keys', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    await expect(
      loadSigningKeys(
        h.db.conn,
        loadIdentityConfig(
          env({
            JWT_PRIVATE_KEY_PEM: a.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            JWT_PUBLIC_KEY_PEM: b.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          }),
        ),
      ),
    ).rejects.toThrow(/does not match/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      loadSigningKeys(h.db.conn, loadIdentityConfig(env({ JWT_PRIVATE_KEY_PEM: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }))),
    ).rejects.toThrow(/Ed25519/);
  });
});

describe('config', () => {
  const prodBase = { APP_MODE: 'production', INTERNAL_SERVICE_SECRET: 'x'.repeat(40) };

  it('production requires JWT_PRIVATE_KEY_PEM and refuses DEMO_* flags', () => {
    expect(() => loadIdentityConfig(env(prodBase))).toThrow(/JWT_PRIVATE_KEY_PEM/);
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem, DEMO_OTP_ENABLED: 'true' }))).toThrow(/DEMO_OTP_ENABLED/);
    expect(() => loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem, DEMO_PHONES: '+919999900001' }))).toThrow(/DEMO_PHONES/);
    expect(loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem })).COOKIE_SECURE).toBe(true);
  });

  it('production rejects COOKIE_SECURE=false (explicit true is fine)', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem, COOKIE_SECURE: 'false' }))).toThrow(/COOKIE_SECURE/);
    expect(() => loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem, COOKIE_SECURE: '0' }))).toThrow(/COOKIE_SECURE/);
    expect(loadIdentityConfig(env({ ...prodBase, JWT_PRIVATE_KEY_PEM: pem, COOKIE_SECURE: 'true' })).COOKIE_SECURE).toBe(true);
  });

  it('COOKIE_SECURE defaults: false in demo, true in sandbox; explicit value wins', () => {
    expect(loadIdentityConfig(env({ APP_MODE: 'demo' })).COOKIE_SECURE).toBe(false);
    expect(loadIdentityConfig(env({ APP_MODE: 'sandbox' })).COOKIE_SECURE).toBe(true);
    expect(loadIdentityConfig(env({ APP_MODE: 'sandbox', COOKIE_SECURE: 'false' })).COOKIE_SECURE).toBe(false);
  });

  it('normalizes DEMO_PHONES and rejects invalid ones; CSRF origins default to CORS_ORIGINS + PUBLIC_WEB_URL', () => {
    expect(loadIdentityConfig(env({ DEMO_PHONES: '09876543210, +91 99999 00001' })).DEMO_PHONES).toEqual(['+919876543210', '+919999900001']);
    expect(() => loadIdentityConfig(env({ DEMO_PHONES: '12345' }))).toThrow(/DEMO_PHONES/);
    const c = loadIdentityConfig(env({ CORS_ORIGINS: 'http://localhost:5173', PUBLIC_WEB_URL: 'https://thali.example/app' }));
    expect(c.CSRF_ALLOWED_ORIGINS.sort()).toEqual(['http://localhost:5173', 'https://thali.example']);
  });
});

describe('rate limits fail CLOSED when Redis is down', () => {
  it('OTP request and admin login → 503', async () => {
    const dead = createRedis('redis://127.0.0.1:1', {
      keyPrefix: h.tr.prefix,
      redisOptions: { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null },
    });
    dead.on('error', () => {});
    try {
      const app = buildApp({
        config: h.config,
        logger: testLogger('identity'),
        conn: h.db.conn,
        redis: dead,
        keys: h.keys,
        notifications: new FakeNotifications(),
        orders: new FakeOrders(),
      });
      const otp = await request(app).post('/api/v1/auth/otp/request').send({ phone: randomPhone() });
      expect(otp.status).toBe(503);
      expect(otp.body.error.code).toBe('SERVICE_UNAVAILABLE');
      const admin = await request(app).post('/api/v1/auth/admin/login').send({ email: 'a@b.co', password: 'whatever' });
      expect(admin.status).toBe(503);
    } finally {
      dead.disconnect();
    }
  });
});
