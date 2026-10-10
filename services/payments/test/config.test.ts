import { describe, expect, it } from 'vitest';
import { ConfigError } from '@thali/service-kit';
import { loadPaymentsConfig } from '../src/config.js';

const base = {
  MONGO_URI: 'mongodb://localhost:27018/?replicaSet=rs0',
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_SERVICE_SECRET: 'x'.repeat(40),
};

describe('payments config', () => {
  it('APP_MODE=production with PAYMENT_PROVIDER=mock → ConfigError', () => {
    const run = () => loadPaymentsConfig({ ...base, APP_MODE: 'production', PAYMENT_PROVIDER: 'mock', MOCK_WEBHOOK_SECRET: 'm'.repeat(20) });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (err) {
      expect((err as ConfigError).issues.join('\n')).toMatch(/PAYMENT_PROVIDER/);
    }
  });

  it('APP_MODE=production without an explicit provider (default mock) → ConfigError', () => {
    expect(() => loadPaymentsConfig({ ...base, APP_MODE: 'production' })).toThrow(ConfigError);
  });

  it('production with razorpay and its secrets loads; razorpay without secrets is refused', () => {
    const cfg = loadPaymentsConfig({
      ...base,
      APP_MODE: 'production',
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_live_x',
      RAZORPAY_KEY_SECRET: 'secret-123456',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret-123456',
    });
    expect(cfg).toMatchObject({ SERVICE_NAME: 'payments', PORT: 4004, PAYMENT_PROVIDER: 'razorpay', PARTNER_BASE_PAYOUT_PAISE: 3000, PARTNER_PER_KM_PAISE: 800 });
    expect(() => loadPaymentsConfig({ ...base, PAYMENT_PROVIDER: 'razorpay' })).toThrow(/RAZORPAY_KEY_ID/);
  });

  it('mock requires MOCK_WEBHOOK_SECRET (demo)', () => {
    expect(() => loadPaymentsConfig({ ...base, PAYMENT_PROVIDER: 'mock' })).toThrow(/MOCK_WEBHOOK_SECRET/);
    expect(loadPaymentsConfig({ ...base, PAYMENT_PROVIDER: 'mock', MOCK_WEBHOOK_SECRET: 'm'.repeat(20) }).PAYMENT_PROVIDER).toBe('mock');
  });
});
