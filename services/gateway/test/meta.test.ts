import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { testLogger } from '@thali/service-kit/testing';
import { buildApp } from '../src/app.js';
import { providerLabel } from '../src/meta.js';
import { loadGatewayConfig } from '../src/config.js';
import { testGatewayConfig } from './helpers.js';

const app = (env: Record<string, string>) => buildApp({ config: testGatewayConfig({}, env), logger: testLogger('gateway') });

describe('GET /api/v1/meta', () => {
  it('demo mode -> mode demo, every provider labelled demo', async () => {
    const res = await request(app({ APP_MODE: 'demo', PAYMENT_PROVIDER: 'mock' })).get('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('demo');
    expect(res.body.providers.payment).toBe('demo');
    expect(res.body).toMatchObject({
      brand: 'Thali',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      providers: { payment: 'demo', sms: 'demo', email: 'demo', maps: 'demo', storage: 'demo' },
    });
  });

  it('sandbox + razorpay -> payment sandbox; mock providers stay demo', async () => {
    const res = await request(
      app({ APP_MODE: 'sandbox', PAYMENT_PROVIDER: 'razorpay', SMS_PROVIDER: 'twilio', EMAIL_PROVIDER: 'mailpit', GEO_PROVIDER: 'google' }),
    ).get('/api/v1/meta');
    expect(res.body.mode).toBe('sandbox');
    expect(res.body.providers).toEqual({ payment: 'sandbox', sms: 'sandbox', email: 'demo', maps: 'sandbox', storage: 'sandbox' });
  });

  it('production + real providers -> live', async () => {
    const res = await request(
      app({
        APP_MODE: 'production',
        INTERNAL_SERVICE_SECRET: 'x'.repeat(40),
        PAYMENT_PROVIDER: 'razorpay',
        SMS_PROVIDER: 'twilio',
        EMAIL_PROVIDER: 'resend',
        GEO_PROVIDER: 'google',
      }),
    ).get('/api/v1/meta');
    expect(res.body.mode).toBe('production');
    expect(Object.values(res.body.providers)).toEqual(['live', 'live', 'live', 'live', 'live']);
  });

  it('is public (no auth) and cacheable briefly', async () => {
    const res = await request(app({})).get('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
  });

  it('providerLabel truth table', () => {
    expect(providerLabel('demo', 'razorpay')).toBe('demo');
    expect(providerLabel('sandbox', 'mock')).toBe('demo');
    expect(providerLabel('sandbox', 'razorpay')).toBe('sandbox');
    expect(providerLabel('production', 'razorpay')).toBe('live');
  });
});

describe('gateway config', () => {
  const base = { INTERNAL_SERVICE_SECRET: 'test-internal-service-secret-0123456789abcdef', REDIS_URL: 'redis://x' };

  it('defaults: port 8080, local service urls, JWKS derived from IDENTITY_URL, limits per LLD 5.4', () => {
    const c = loadGatewayConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.IDENTITY_URL).toBe('http://localhost:4001');
    expect(c.NOTIFICATIONS_URL).toBe('http://localhost:4006');
    expect(c.JWKS_URL).toBe('http://localhost:4001/.well-known/jwks.json');
    expect(c.RATE_LIMIT_GLOBAL_PER_MIN).toBe(300);
    expect(c.RATE_LIMIT_DISCOVERY_PER_MIN).toBe(60);
    expect(c.RATE_LIMIT_OTP_PER_MIN).toBe(10);
    expect(c.HEALTH_TIMEOUT_MS).toBe(3000);
    expect(c.TRUST_PROXY).toBe('loopback');
  });

  it('TRUST_PROXY=1 parses to a hop count; explicit JWKS_URL wins', () => {
    const c = loadGatewayConfig({ ...base, TRUST_PROXY: '1', JWKS_URL: 'http://id:4001/.well-known/jwks.json' });
    expect(c.TRUST_PROXY).toBe(1);
    expect(c.JWKS_URL).toBe('http://id:4001/.well-known/jwks.json');
  });

  it('production refuses mock providers (including defaults)', () => {
    expect(() => loadGatewayConfig({ ...base, APP_MODE: 'production', INTERNAL_SERVICE_SECRET: 'y'.repeat(40) })).toThrow(/PROVIDER/);
  });
});
