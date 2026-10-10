import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from '@thali/service-kit';

const base = {
  SERVICE_NAME: 'payments',
  PORT: '4004',
  APP_MODE: 'demo',
  MONGO_URI: 'mongodb://localhost:27018/?replicaSet=rs0&directConnection=true',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_SERVICE_SECRET: 's'.repeat(32),
  JWKS_URL: 'http://identity:4001/.well-known/jwks.json',
};

const paymentsShape = {
  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']),
  DEMO_OTP_ENABLED: z.stringbool().default(false),
};

describe('loadConfig', () => {
  it('parses base config with defaults in demo mode', () => {
    const cfg = loadConfig({}, base);
    expect(cfg).toMatchObject({
      SERVICE_NAME: 'payments',
      PORT: 4004,
      APP_MODE: 'demo',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      DOCS_ENABLED: false,
      EVENT_STREAM_PREFIX: '',
      REDIS_KEY_PREFIX: 'thali:',
    });
  });

  it('parses service fields, CSV origins and booleans', () => {
    const cfg = loadConfig(paymentsShape, {
      ...base,
      PAYMENT_PROVIDER: 'mock',
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:8080',
      DOCS_ENABLED: 'true',
      EVENT_STREAM_PREFIX: 'test1:',
      REDIS_KEY_PREFIX: 'test1:',
    });
    expect(cfg.PAYMENT_PROVIDER).toBe('mock');
    expect(cfg.DEMO_OTP_ENABLED).toBe(false);
    expect(cfg.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8080']);
    expect(cfg.DOCS_ENABLED).toBe(true);
    expect(cfg.EVENT_STREAM_PREFIX).toBe('test1:');
    expect(cfg.REDIS_KEY_PREFIX).toBe('test1:');
  });

  it('treats a blank optional URL (JWKS_URL=) as unset', () => {
    expect(loadConfig({}, { ...base, JWKS_URL: '' }).JWKS_URL).toBeUndefined();
    expect(() => loadConfig({}, { ...base, JWKS_URL: 'not a url' })).toThrow(/JWKS_URL/);
  });

  it('demo mode allows mock providers and demo flags', () => {
    const cfg = loadConfig(paymentsShape, { ...base, PAYMENT_PROVIDER: 'mock', DEMO_OTP_ENABLED: 'true' });
    expect(cfg.DEMO_OTP_ENABLED).toBe(true);
  });

  it('missing MONGO_URI throws a ConfigError naming the variable', () => {
    const { MONGO_URI: _omit, ...env } = base;
    expect(() => loadConfig({}, env)).toThrow(ConfigError);
    expect(() => loadConfig({}, env)).toThrow(/MONGO_URI/);
  });

  it('invalid APP_MODE throws naming the variable', () => {
    expect(() => loadConfig({}, { ...base, APP_MODE: 'staging' })).toThrow(/APP_MODE/);
  });

  it('missing service field throws naming it', () => {
    expect(() => loadConfig(paymentsShape, base)).toThrow(/PAYMENT_PROVIDER/);
  });

  it('production + PAYMENT_PROVIDER=mock throws listing the offending var', () => {
    const env = { ...base, APP_MODE: 'production', PAYMENT_PROVIDER: 'mock' };
    expect(() => loadConfig(paymentsShape, env)).toThrow(ConfigError);
    expect(() => loadConfig(paymentsShape, env)).toThrow(/PAYMENT_PROVIDER/);
  });

  it('production + mock provider in env not declared in shape still throws', () => {
    const env = { ...base, APP_MODE: 'production', SMS_PROVIDER: 'mock' };
    expect(() => loadConfig({}, env)).toThrow(/SMS_PROVIDER/);
  });

  it('production + a shape default of mock throws', () => {
    const shape = { EMAIL_PROVIDER: z.enum(['resend', 'mock']).default('mock') };
    expect(() => loadConfig(shape, { ...base, APP_MODE: 'production' })).toThrow(/EMAIL_PROVIDER/);
  });

  it('production + DEMO_OTP_ENABLED=true throws', () => {
    const env = { ...base, APP_MODE: 'production', PAYMENT_PROVIDER: 'razorpay', DEMO_OTP_ENABLED: 'true' };
    expect(() => loadConfig(paymentsShape, env)).toThrow(/DEMO_OTP_ENABLED/);
  });

  it('production + DEMO_PHONES set throws', () => {
    const env = { ...base, APP_MODE: 'production', DEMO_PHONES: '+919000000001' };
    expect(() => loadConfig({}, env)).toThrow(/DEMO_PHONES/);
  });

  it('production lists every offending var in one error', () => {
    const env = { ...base, APP_MODE: 'production', SMS_PROVIDER: 'mock', EMAIL_PROVIDER: 'mock', DEMO_OTP_ENABLED: 'true' };
    let message = '';
    try {
      loadConfig({}, env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SMS_PROVIDER/);
    expect(message).toMatch(/EMAIL_PROVIDER/);
    expect(message).toMatch(/DEMO_OTP_ENABLED/);
  });

  it('production passes with real providers and demo flags off', () => {
    const env = { ...base, APP_MODE: 'production', PAYMENT_PROVIDER: 'razorpay', DEMO_OTP_ENABLED: 'false' };
    const cfg = loadConfig(paymentsShape, env);
    expect(cfg.APP_MODE).toBe('production');
    expect(cfg.PAYMENT_PROVIDER).toBe('razorpay');
  });

  it('production requires an INTERNAL_SERVICE_SECRET of at least 32 chars', () => {
    const env = { ...base, APP_MODE: 'production', INTERNAL_SERVICE_SECRET: 'short-secret-1234' };
    expect(() => loadConfig({}, env)).toThrow(/INTERNAL_SERVICE_SECRET/);
  });
});
