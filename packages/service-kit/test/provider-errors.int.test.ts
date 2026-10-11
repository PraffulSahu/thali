import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthDetails, initEventCollections, providerLastErrors, recordProviderError, scrubProviderMessage } from '@thali/service-kit';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@thali/service-kit/testing';

let db: TestDb;
let tr: TestRedis;

beforeAll(async () => {
  db = await createTestDb('kit_provider_errors');
  tr = await createTestRedis();
  await initEventCollections(db.conn);
});
afterAll(async () => {
  await tr.cleanup();
  await db.drop();
});

describe('scrubProviderMessage', () => {
  it('removes emails, phone numbers and secrets; keeps infra detail; caps length', () => {
    expect(scrubProviderMessage('SMTP connect ECONNREFUSED 10.0.3.12:587')).toBe('SMTP connect ECONNREFUSED 10.0.3.12:587');
    expect(scrubProviderMessage('rejected recipient someone@example.com')).toBe('rejected recipient [email]');
    expect(scrubProviderMessage('sms to +919876543210 failed')).toBe('sms to [phone] failed');
    expect(scrubProviderMessage('sms to 9876543210 failed')).toBe('sms to [phone] failed');
    expect(scrubProviderMessage('GET /geocode/json?latlng=1,2&key=AIzaSyABC123 403')).toBe('GET /geocode/json?latlng=1,2&key=[redacted] 403');
    expect(scrubProviderMessage('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [redacted]');
    expect(scrubProviderMessage('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('recordProviderError with message (GW-1)', () => {
  it('keeps the last scrubbed message per provider and exposes it in healthDetails.lastProviderErrors', async () => {
    const t1 = Date.now() - 60_000;
    const t2 = Date.now() - 1_000;
    await recordProviderError(tr.redis, 'notifications', 'smtp', t1, 'SMTP connect ECONNREFUSED 10.0.3.12:587');
    await recordProviderError(tr.redis, 'notifications', 'smtp', t2, 'mailbox full for a@b.co');
    await recordProviderError(tr.redis, 'notifications', 'twilio'); // no message: counted, message null
    await recordProviderError(tr.redis, 'notifications', 'stale', Date.now() - 2 * 3600_000, 'old'); // outside the window

    const last = await providerLastErrors(tr.redis, 'notifications');
    expect(last.smtp).toEqual({ message: 'mailbox full for [email]', at: new Date(t2).toISOString() });
    expect(last.twilio!.message).toBeNull();
    expect(last.stale).toBeUndefined();

    const d = await healthDetails({ conn: db.conn, redis: tr.redis, service: 'notifications', mode: 'demo' });
    expect(d.providerErrorsLastHour).toBe(3);
    expect(d.lastProviderErrors).toEqual(last);
  });

  it('an older write never replaces a newer last message', async () => {
    const now = Date.now();
    await recordProviderError(tr.redis, 'payments', 'razorpay', now - 1000, 'newer');
    await recordProviderError(tr.redis, 'payments', 'razorpay', now - 5000, 'older');
    expect((await providerLastErrors(tr.redis, 'payments')).razorpay!.message).toBe('newer');
  });

  it('healthDetails reports lastProviderErrors {} when nothing failed', async () => {
    const d = await healthDetails({ conn: db.conn, redis: tr.redis, service: 'identity', mode: 'demo' });
    expect(d.lastProviderErrors).toEqual({});
  });
});
