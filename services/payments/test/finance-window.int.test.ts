import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import { istDayStart, postEntry } from '../src/domain/ledger.js';
import { oid, setup, type Harness } from './helpers.js';

let h: Harness;
const owner = oid();
const rest = oid();
const partnerA = oid();
const partnerB = oid();

const NOW = new Date('2026-10-11T10:00:00.000Z'); // 15:30 IST on 11 Oct
const IST_MIDNIGHT = '2026-10-10T18:30:00.000Z';

async function post(at: string, accountType: 'PARTNER' | 'RESTAURANT', accountId: string, entryType: 'DELIVERY_EARNING' | 'ORDER_EARNING' | 'COMMISSION', amountPaise: number, key: string) {
  h.clock.now = new Date(at);
  await withTransaction(h.ctx.conn, (s) => postEntry(h.ctx, s, { accountType, accountId, entryType, amountPaise, dedupeKey: key, memo: key, createdBy: 'test' }));
}

beforeAll(async () => {
  h = await setup('window');
  h.marketplace.add(rest, owner);
  await post('2026-10-10T18:00:00.000Z', 'PARTNER', partnerA, 'DELIVERY_EARNING', 9_900, 'a-before'); // 23:30 IST yesterday
  await post('2026-10-10T19:00:00.000Z', 'PARTNER', partnerA, 'DELIVERY_EARNING', 10_000, 'a-1'); // 00:30 IST today
  await post('2026-10-11T09:00:00.000Z', 'PARTNER', partnerA, 'DELIVERY_EARNING', 54_200, 'a-2');
  await post('2026-10-11T09:30:00.000Z', 'PARTNER', partnerB, 'DELIVERY_EARNING', 7_000, 'b-1');
  await post('2026-10-10T18:00:00.000Z', 'RESTAURANT', rest, 'ORDER_EARNING', 1_000, 'r-before');
  await post('2026-10-11T08:00:00.000Z', 'RESTAURANT', rest, 'ORDER_EARNING', 50_000, 'r-1');
  await post('2026-10-11T08:00:00.000Z', 'RESTAURANT', rest, 'COMMISSION', -9_000, 'r-c1');
  h.clock.now = NOW;
});
afterAll(async () => {
  await h.cleanup();
});

const partnerTok = (sub: string) => h.keys.sign({ sub, roles: ['CONSUMER', 'DELIVERY_PARTNER'] });
const ownerTok = (sub: string) => h.keys.sign({ sub, roles: ['CONSUMER', 'RESTAURANT_OWNER'] });

describe('istDayStart', () => {
  it('returns the UTC instant of IST midnight', () => {
    expect(istDayStart(NOW).toISOString()).toBe(IST_MIDNIGHT);
    expect(istDayStart(new Date('2026-10-10T18:29:59.999Z')).toISOString()).toBe('2026-10-09T18:30:00.000Z');
    expect(istDayStart(new Date('2026-10-10T18:30:00.000Z')).toISOString()).toBe(IST_MIDNIGHT);
  });
});

describe('PAY-1 windowed earnings', () => {
  it('partner summary defaults to today in IST (midnight IST to now) and keeps the all-time fields', async () => {
    const res = await request(h.app).get('/api/v1/finance/partner/summary').set('authorization', `Bearer ${await partnerTok(partnerA)}`);
    expect(res.status).toBe(200);
    expect(res.body.balancePaise).toBe(9_900 + 10_000 + 54_200);
    expect(res.body.window).toEqual({
      from: IST_MIDNIGHT,
      to: NOW.toISOString(),
      earningsPaise: 64_200,
      entriesByType: { DELIVERY_EARNING: 64_200 },
      deliveries: 2,
    });
  });

  it('restaurant summary: earnings = sum of window entries, deliveries counts only DELIVERY_EARNING', async () => {
    const res = await request(h.app).get(`/api/v1/finance/restaurants/${rest}/summary`).set('authorization', `Bearer ${await ownerTok(owner)}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toEqual({
      from: IST_MIDNIGHT,
      to: NOW.toISOString(),
      earningsPaise: 41_000,
      entriesByType: { ORDER_EARNING: 50_000, COMMISSION: -9_000 },
      deliveries: 0,
    });
  });

  it('honours explicit from/to (half-open) and never leaks another account', async () => {
    const q = new URLSearchParams({ from: '2026-10-10T17:00:00.000Z', to: '2026-10-10T19:00:00.000Z' });
    const res = await request(h.app).get(`/api/v1/finance/partner/summary?${q}`).set('authorization', `Bearer ${await partnerTok(partnerA)}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toMatchObject({ from: '2026-10-10T17:00:00.000Z', to: '2026-10-10T19:00:00.000Z', earningsPaise: 9_900, deliveries: 1 });
    const b = await request(h.app).get('/api/v1/finance/partner/summary').set('authorization', `Bearer ${await partnerTok(partnerB)}`);
    expect(b.body.window).toMatchObject({ earningsPaise: 7_000, deliveries: 1 });
  });

  it('empty window returns zeros', async () => {
    const q = new URLSearchParams({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
    const res = await request(h.app).get(`/api/v1/finance/partner/summary?${q}`).set('authorization', `Bearer ${await partnerTok(partnerA)}`);
    expect(res.body.window).toMatchObject({ earningsPaise: 0, entriesByType: {}, deliveries: 0 });
  });

  it('only `to` given: from defaults to IST midnight of that day', async () => {
    const res = await request(h.app).get('/api/v1/finance/partner/summary?to=2026-10-10T19:30:00.000Z').set('authorization', `Bearer ${await partnerTok(partnerA)}`);
    expect(res.body.window).toMatchObject({ from: IST_MIDNIGHT, earningsPaise: 10_000, deliveries: 1 });
  });

  it('validates the window: from<to, max 93 days, ISO dates', async () => {
    const t = await partnerTok(partnerA);
    const get = (qs: string) => request(h.app).get(`/api/v1/finance/partner/summary?${qs}`).set('authorization', `Bearer ${t}`);
    for (const qs of [
      'from=2026-10-11T00:00:00.000Z&to=2026-10-11T00:00:00.000Z',
      'from=2026-10-12T00:00:00.000Z&to=2026-10-11T00:00:00.000Z',
      'from=2026-06-01T00:00:00.000Z&to=2026-10-11T00:00:00.000Z', // > 93 days
      'from=yesterday',
      'from=2026-10-12T00:00:00.000Z', // from after the default `to` (now)
    ]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    const ok = await get('from=2026-07-10T00:00:00.000Z&to=2026-10-11T00:00:00.000Z'); // exactly 93 days
    expect(ok.status).toBe(200);
  });
});
