/** GW-1: per-service explanation (status, degradedReasons, summary, providers) from health details. */
import { describe, expect, it } from 'vitest';
import { explainHealth } from '../src/health.js';

const NOW = Date.parse('2026-10-11T08:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const base = (over: Record<string, unknown> = {}) => ({
  service: 'notifications',
  mode: 'demo',
  mongo: 'up',
  redis: 'up',
  outboxPending: 0,
  outboxOldestAgeSec: null,
  consumerLag: { 'events.orders': 0 },
  deadLetters: 0,
  providerErrorsLastHour: 0,
  providerErrorsByProvider: {},
  lastProviderErrors: {},
  checkedAt: ago(0),
  ...over,
});

describe('explainHealth', () => {
  it('all quiet → up, no reasons, expected providers listed as up', () => {
    const e = explainHealth('notifications', base(), { now: NOW, geoProvider: 'demo' });
    expect(e).toEqual({ status: 'up', degradedReasons: [], summary: 'All checks passing', providers: { email: 'up', sms: 'up' } });
    expect(explainHealth('payments', base({ service: 'payments' }), { now: NOW, geoProvider: 'demo' }).providers).toEqual({ payment: 'up' });
    expect(explainHealth('orders', base({ service: 'orders' }), { now: NOW, geoProvider: 'demo' }).providers).toEqual({});
    expect(explainHealth('delivery', base({ service: 'delivery' }), { now: NOW, geoProvider: 'google' }).providers).toEqual({ maps: 'up' });
  });

  it('SMTP failing → degraded with "email provider failing: <message>", never down', () => {
    const e = explainHealth(
      'notifications',
      base({
        providerErrorsLastHour: 7,
        providerErrorsByProvider: { mailpit: 7 },
        lastProviderErrors: { mailpit: { message: 'SMTP connect ECONNREFUSED 10.0.3.12:587', at: ago(1) } },
      }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(e.status).toBe('degraded');
    expect(e.providers).toEqual({ email: 'failing', sms: 'up' });
    expect(e.degradedReasons).toEqual(['email provider failing (7 errors in the last hour): SMTP connect ECONNREFUSED 10.0.3.12:587']);
    expect(e.summary).toBe('Email provider failing: SMTP connect ECONNREFUSED 10.0.3.12:587');
  });

  it('a single recent provider error marks the provider failing; an old single error does not', () => {
    const recent = explainHealth(
      'payments',
      base({ providerErrorsLastHour: 1, providerErrorsByProvider: { razorpay: 1 }, lastProviderErrors: { razorpay: { message: 'HTTP 502', at: ago(3) } } }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(recent.providers.payment).toBe('failing');
    expect(recent.status).toBe('degraded');
    const old = explainHealth(
      'payments',
      base({ providerErrorsLastHour: 1, providerErrorsByProvider: { razorpay: 1 }, lastProviderErrors: { razorpay: { message: 'HTTP 502', at: ago(40) } } }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(old.providers.payment).toBe('up');
    expect(old.status).toBe('up');
  });

  it('google-* errors roll up into "maps"; ≥ 5 in the hour → failing', () => {
    const e = explainHealth(
      'marketplace',
      base({
        providerErrorsLastHour: 6,
        providerErrorsByProvider: { 'google-places': 3, 'google-geocode': 3 },
        lastProviderErrors: { 'google-places': { message: null, at: ago(30) }, 'google-geocode': { message: 'HTTP 403', at: ago(20) } },
      }),
      { now: NOW, geoProvider: 'google' },
    );
    expect(e.providers).toEqual({ maps: 'failing' });
    expect(e.degradedReasons).toEqual(['maps provider failing (6 errors in the last hour): HTTP 403']);
  });

  it('≥ 5 provider errors in the hour spread over providers → degraded even if none is failing on its own', () => {
    const e = explainHealth(
      'notifications',
      base({
        providerErrorsLastHour: 6,
        providerErrorsByProvider: { mailpit: 3, twilio: 3 },
        lastProviderErrors: { mailpit: { message: null, at: ago(30) }, twilio: { message: null, at: ago(30) } },
      }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(e.providers).toEqual({ email: 'up', sms: 'up' });
    expect(e.status).toBe('degraded');
    expect(e.degradedReasons).toEqual(['6 provider errors in the last hour']);
  });

  it('unknown provider names are reported under their own name', () => {
    const e = explainHealth(
      'identity',
      base({ providerErrorsLastHour: 1, providerErrorsByProvider: { notifications: 1 }, lastProviderErrors: { notifications: { message: 'connect ECONNREFUSED', at: ago(2) } } }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(e.providers).toEqual({ notifications: 'failing' });
    expect(e.degradedReasons[0]).toMatch(/^notifications provider failing/);
  });

  it('lag, outbox age, dead letters, mongo/redis down → degraded with one reason each', () => {
    const e = explainHealth(
      'orders',
      base({ service: 'orders', mongo: 'down', redis: 'down', consumerLag: { 'events.payments': 250, 'events.delivery': 3 }, outboxOldestAgeSec: 75, deadLetters: 3 }),
      { now: NOW, geoProvider: 'demo' },
    );
    expect(e.status).toBe('degraded');
    expect(e.degradedReasons).toEqual([
      'database unreachable',
      'redis unreachable',
      'event backlog: events.payments 250 behind',
      'outbox: oldest unpublished event 75s old',
      '3 dead letters awaiting replay',
    ]);
    expect(e.summary).toBe('Database unreachable; redis unreachable; event backlog: events.payments 250 behind; +2 more');
  });

  it('thresholds are strict: lag 100 and outbox 60s are still fine', () => {
    const e = explainHealth('orders', base({ consumerLag: { a: 100 }, outboxOldestAgeSec: 60 }), { now: NOW, geoProvider: 'demo' });
    expect(e.status).toBe('up');
  });

  it('tolerates details from services that predate GW-1 (no lastProviderErrors) and nulls', () => {
    const e = explainHealth(
      'notifications',
      { ...base({ providerErrorsLastHour: null, providerErrorsByProvider: null, deadLetters: null, consumerLag: { x: null } }), lastProviderErrors: undefined },
      { now: NOW, geoProvider: 'demo' },
    );
    expect(e.status).toBe('up');
    expect(e.providers).toEqual({ email: 'up', sms: 'up' });
  });
});
