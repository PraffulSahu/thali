import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, fullProfile, settlementBody, type Harness } from './helpers.js';

let h: Harness;
let a: string; // owner A token
let b: string; // owner B token
let ra: string; // A's restaurant
let rb: string; // B's restaurant
let catA: string;
let itemA: string;

beforeAll(async () => {
  h = await createHarness('owner_isolation');
  a = await h.ownerToken();
  b = await h.ownerToken();
  ra = (await request(h.app).post('/api/v1/owner/restaurants').set(bearer(a)).send({ name: 'A Place' })).body.restaurant.id;
  rb = (await request(h.app).post('/api/v1/owner/restaurants').set(bearer(b)).send({ name: 'B Place' })).body.restaurant.id;
  catA = (await request(h.app).post(`/api/v1/owner/restaurants/${ra}/categories`).set(bearer(a)).send({ name: 'Cat' })).body.id;
  itemA = (await request(h.app).post(`/api/v1/owner/restaurants/${ra}/items`).set(bearer(a)).send({ categoryId: catA, name: 'Thing', pricePaise: 100, isVeg: true })).body.id;
});
afterAll(async () => h?.close());

describe('R-8 owner isolation', () => {
  it('every owner route on another owner’s restaurant → 404 (no existence leak)', async () => {
    const p = `/api/v1/owner/restaurants/${ra}`;
    const calls: [string, string, Record<string, unknown>?][] = [
      ['get', p],
      ['patch', p, { name: 'x' }],
      ['post', `${p}/submit`],
      ['post', `${p}/resend-verification`],
      ['put', `${p}/settlement`, settlementBody],
      ['put', `${p}/hours`, { hours: [] }],
      ['post', `${p}/pause`, { minutes: 10 }],
      ['post', `${p}/resume`],
      ['post', `${p}/uploads`, { purpose: 'IMAGE', contentType: 'image/png', sizeBytes: 100 }],
      ['post', `${p}/documents`, { type: 'FSSAI', key: `restaurants/${ra}/documents/x.pdf` }],
      ['get', `${p}/categories`],
      ['post', `${p}/categories`, { name: 'x' }],
      ['patch', `${p}/categories/${catA}`, { name: 'x' }],
      ['delete', `${p}/categories/${catA}`],
      ['get', `${p}/items`],
      ['post', `${p}/items`, { categoryId: catA, name: 'x', pricePaise: 1, isVeg: true }],
      ['get', `${p}/items/${itemA}`],
      ['patch', `${p}/items/${itemA}`, { name: 'x' }],
      ['patch', `${p}/items/${itemA}/availability`, { available: false }],
      ['delete', `${p}/items/${itemA}`],
    ];
    for (const [method, path, body] of calls) {
      const req = (request(h.app) as unknown as Record<string, (u: string) => request.Test>)[method]!(path).set(bearer(b));
      const res = body ? await req.send(body) : await req;
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    const doc = await h.models.Restaurant.findById(ra).lean();
    expect(doc!.name).toBe('A Place');
    expect(doc!.pausedUntil ?? null).toBeNull();
    expect(await h.models.MenuItem.countDocuments({ restaurantId: ra })).toBe(1);
  });

  it('an item/category of restaurant A cannot be addressed through owner B’s own restaurant', async () => {
    const p = `/api/v1/owner/restaurants/${rb}`;
    expect((await request(h.app).get(`${p}/items/${itemA}`).set(bearer(b))).status).toBe(404);
    expect((await request(h.app).patch(`${p}/items/${itemA}`).set(bearer(b)).send({ name: 'x' })).status).toBe(404);
    expect((await request(h.app).patch(`${p}/categories/${catA}`).set(bearer(b)).send({ name: 'x' })).status).toBe(404);
    const viaForeignCat = await request(h.app).post(`${p}/items`).set(bearer(b)).send({ categoryId: catA, name: 'x', pricePaise: 1, isVeg: true });
    expect(viaForeignCat.status).toBe(404);
  });

  it('documents attach refuses keys outside the restaurant’s own prefix', async () => {
    await request(h.app).patch(`/api/v1/owner/restaurants/${rb}`).set(bearer(b)).send(fullProfile()).expect(200);
    const res = await request(h.app)
      .post(`/api/v1/owner/restaurants/${rb}/documents`)
      .set(bearer(b))
      .send({ type: 'FSSAI', key: `restaurants/${ra}/documents/stolen.pdf` });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FILE_INVALID');
  });

  it('malformed ids → 404/400, never 500', async () => {
    const r = await request(h.app).get('/api/v1/owner/restaurants/not-an-id').set(bearer(a));
    expect([400, 404]).toContain(r.status);
  });
});
