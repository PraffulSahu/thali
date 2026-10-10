/** MKT-1: gazetteer loader, address autocomplete, place details, reverse geocoding, Google fallback. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { DomainError } from '@thali/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertLocalities, type LocalitySeedRow } from '../src/domain/localities.js';
import { createHarness, seedServiceArea, type Harness } from './helpers.js';

const ROWS: LocalitySeedRow[] = [
  { name: 'Indiranagar', pincode: '560038', lat: 12.9784, lng: 77.6408, streets: ['12th Main Road', '100 Feet Road', 'CMH Road'] },
  { name: 'Koramangala', pincode: '560034', lat: 12.9352, lng: 77.6245, streets: ['80 Feet Road', '1st Main Road'] },
  { name: 'Indira Nagar Extension', pincode: null, lat: 13.02, lng: 77.6, streets: [] },
];

describe('gazetteer + places (demo geo)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness('places', { SEED_DATA_DIR: '/nonexistent-dir' });
    await seedServiceArea(h.models);
    expect(await upsertLocalities(h.db.conn, ROWS)).toEqual({ localities: 3, roads: 5 });
  });
  afterAll(async () => h?.close());

  it('upsertLocalities is idempotent (deterministic ids, upserts)', async () => {
    await upsertLocalities(h.db.conn, ROWS);
    expect(await h.models.Locality.countDocuments()).toBe(8);
    const road = await h.models.Locality.findOne({ kind: 'ROAD', primary: '12th Main Road' }).lean();
    expect(road).toMatchObject({ name: '12th Main Road, Indiranagar', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', isDemo: true });
  });

  it('autocomplete: prefix words, localities first, labelled DEMO_GAZETTEER', async () => {
    const res = await request(h.app).get('/api/v1/discovery/places').query({ q: 'indira' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('DEMO_GAZETTEER');
    expect(res.body.items[0]).toMatchObject({
      primary: 'Indiranagar',
      secondary: 'Bengaluru 560038',
      locality: 'Indiranagar',
      city: 'Bengaluru',
      pincode: '560038',
      location: { lat: 12.9784, lng: 77.6408 },
      source: 'DEMO_GAZETTEER',
    });
    expect(res.body.items[0].id).toMatch(/^gz_[a-f0-9]{24}$/);
    const road = await request(h.app).get('/api/v1/discovery/places').query({ q: '12th main indi' });
    expect(road.body.items).toEqual([expect.objectContaining({ primary: '12th Main Road', secondary: 'Indiranagar, Bengaluru' })]);
    const limited = await request(h.app).get('/api/v1/discovery/places').query({ q: 'road', limit: 2 });
    expect(limited.body.items).toHaveLength(2);
    // bias: nearest first among equals
    const biased = await request(h.app).get('/api/v1/discovery/places').query({ q: '80 feet', lat: 12.93, lng: 77.62 });
    expect(biased.body.items[0].locality).toBe('Koramangala');
    expect((await request(h.app).get('/api/v1/discovery/places').query({ q: 'i' })).status).toBe(400);
    expect((await request(h.app).get('/api/v1/discovery/places').query({ q: 'zzzz' })).body.items).toEqual([]);
  });

  it('place details: coordinates + serviceability; unknown ids → 404', async () => {
    const s = await request(h.app).get('/api/v1/discovery/places').query({ q: 'koramangala' });
    const d = await request(h.app).get(`/api/v1/discovery/places/${s.body.items[0].id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      formattedAddress: 'Koramangala, Bengaluru 560034',
      locality: 'Koramangala',
      pincode: '560034',
      location: { lat: 12.9352, lng: 77.6245 },
      serviceable: true,
      serviceArea: { name: 'Bengaluru Central' },
      source: 'DEMO_GAZETTEER',
    });
    expect((await request(h.app).get('/api/v1/discovery/places/gz_000000000000000000000000')).status).toBe(404);
    expect((await request(h.app).get('/api/v1/discovery/places/ChIJsomething')).status).toBe(404); // demo geo has no Google
  });

  it('reverse: nearest locality within 3 km, else a coordinate label; serviceability always computed', async () => {
    const r = await request(h.app).get('/api/v1/discovery/reverse').query({ lat: 12.979, lng: 77.641 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ label: 'Indiranagar, Bengaluru', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', serviceable: true, serviceArea: expect.objectContaining({ name: 'Bengaluru Central' }), source: 'DEMO_GAZETTEER' });
    const far = await request(h.app).get('/api/v1/discovery/reverse').query({ lat: 19.07, lng: 72.87 });
    expect(far.body).toMatchObject({ label: '19.07000, 72.87000', locality: null, serviceable: false, serviceArea: null });
    expect((await request(h.app).get('/api/v1/discovery/reverse').query({ lat: 100, lng: 0 })).status).toBe(400);
  });

  it('Google provider: used + cached when it works; any failure falls back to the gazetteer (no 5xx)', async () => {
    const geo = h.ctx.geo as unknown as Record<string, unknown>;
    let calls = 0;
    geo.autocomplete = async (q: string) => {
      calls++;
      return [{ id: 'ChIJabc', primary: `${q} Rd`, secondary: 'Indiranagar, Bengaluru, Karnataka, India', locality: null, city: null, pincode: null, location: null }];
    };
    geo.reverse = async () => ({ label: '12th Main Rd, Indiranagar', formattedAddress: 'x', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', location: { lat: 1, lng: 1 } });
    geo.placeDetails = async (id: string) => (id === 'ChIJabc' ? { id, formattedAddress: '12th Main Rd, Indiranagar, Bengaluru', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', location: { lat: 12.9784, lng: 77.6408 } } : null);
    try {
      const a = await request(h.app).get('/api/v1/discovery/places').query({ q: 'twelfth' });
      expect(a.body).toMatchObject({ source: 'GOOGLE', items: [{ id: 'ChIJabc', primary: 'twelfth Rd', source: 'GOOGLE', location: null }] });
      await request(h.app).get('/api/v1/discovery/places').query({ q: 'Twelfth ' });
      expect(calls).toBe(1); // cached (normalised query)
      const d = await request(h.app).get('/api/v1/discovery/places/ChIJabc');
      expect(d.body).toMatchObject({ source: 'GOOGLE', serviceable: true, locality: 'Indiranagar' });
      expect((await request(h.app).get('/api/v1/discovery/places/ChIJmissing')).status).toBe(404);
      const rev = await request(h.app).get('/api/v1/discovery/reverse').query({ lat: 12.97, lng: 77.64 });
      expect(rev.body).toMatchObject({ label: '12th Main Rd, Indiranagar', source: 'GOOGLE', serviceable: true });

      const down = async () => {
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'google down');
      };
      geo.autocomplete = down;
      geo.reverse = down;
      geo.placeDetails = down;
      const fb = await request(h.app).get('/api/v1/discovery/places').query({ q: 'koramangala' });
      expect(fb.status).toBe(200);
      expect(fb.body.source).toBe('DEMO_GAZETTEER');
      expect(fb.body.items[0]).toMatchObject({ primary: 'Koramangala', source: 'DEMO_GAZETTEER' });
      const rfb = await request(h.app).get('/api/v1/discovery/reverse').query({ lat: 12.9352, lng: 77.6245 });
      expect(rfb.body).toMatchObject({ source: 'DEMO_GAZETTEER', locality: 'Koramangala' });
      // gazetteer ids still resolve while Google is down; Google ids cannot → 502 UPSTREAM_UNAVAILABLE
      expect((await request(h.app).get(`/api/v1/discovery/places/${fb.body.items[0].id}`)).status).toBe(200);
      expect((await request(h.app).get('/api/v1/discovery/places/ChIJother')).body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      delete geo.autocomplete;
      delete geo.reverse;
      delete geo.placeDetails;
    }
  });
});

describe('gazetteer lazy load (demo mode, empty collection)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'thali-seed-'));
    await writeFile(path.join(dir, 'localities.json'), JSON.stringify(ROWS));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('loads SEED_DATA_DIR/localities.json on first use', async () => {
    const h = await createHarness('places_lazy', { SEED_DATA_DIR: dir });
    try {
      const res = await request(h.app).get('/api/v1/discovery/places').query({ q: 'cmh' });
      expect(res.body.items).toEqual([expect.objectContaining({ primary: 'CMH Road', locality: 'Indiranagar' })]);
      expect(await h.models.Locality.countDocuments()).toBe(8);
    } finally {
      await h.close();
    }
  });

  it('a failed load is not memoised: a broken file is retried on the next lookup', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'thali-seed-bad-'));
    try {
      await writeFile(path.join(bad, 'localities.json'), '{ not json');
      const h = await createHarness('places_retry', { SEED_DATA_DIR: bad });
      try {
        expect((await request(h.app).get('/api/v1/discovery/places').query({ q: 'cmh' })).body.items).toEqual([]);
        await writeFile(path.join(bad, 'localities.json'), JSON.stringify(ROWS));
        expect((await request(h.app).get('/api/v1/discovery/places').query({ q: 'cmh' })).body.items).toHaveLength(1);
      } finally {
        await h.close();
      }
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  it('missing file → empty results, not an error', async () => {
    const h = await createHarness('places_nofile', { SEED_DATA_DIR: path.join(dir, 'missing') });
    try {
      const res = await request(h.app).get('/api/v1/discovery/places').query({ q: 'indiranagar' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], source: 'DEMO_GAZETTEER' });
    } finally {
      await h.close();
    }
  });
});
