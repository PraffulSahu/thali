/**
 * UI-redesign discovery + menu fields: MKT-2 counts, MKT-11 facets, MKT-3 paused/closedReason,
 * MKT-12 closesAt, MKT-13 menuStats/cache/text search, MKT-4 pureVeg, MKT-5 locality, MKT-6
 * unavailableReason/stockLeft, MKT-9 featured/recommended, MKT-10 image refs.
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recomputeMenuStats } from '../src/domain/menu-stats.js';
import { bumpDiscoveryEpoch } from '../src/domain/discovery-cache.js';
import { bearer, createHarness, newId, northOf, seedRestaurant, seedServiceArea, type Harness } from './helpers.js';

const drop = { lat: 12.95, lng: 77.62 };
const ist = (local: string) => new Date(`${local}+05:30`);

async function addItem(h: Harness, restaurantId: string, fields: Record<string, unknown> = {}) {
  const cat = await h.models.MenuCategory.create({ restaurantId, name: 'Mains', sortOrder: 1, active: true });
  const doc = await h.models.MenuItem.create({
    restaurantId,
    categoryId: cat._id,
    name: 'Item',
    description: '',
    pricePaise: 20000,
    isVeg: true,
    available: true,
    trackStock: false,
    stockQty: 0,
    reservedQty: 0,
    customizationGroups: [],
    tags: [],
    ...fields,
  });
  return String(doc._id);
}

describe('discovery: counts, facets, paused, closesAt, veg, locality, images', () => {
  let h: Harness;
  let biryani: string; // mixed, non-veg item toggled OFF (old bug: shown as pure veg)
  let dosa: string; // all veg, never declared
  let declaredMixed: string; // pureVeg false declared, all-veg menu
  let paused: string;
  beforeAll(async () => {
    h = await createHarness('disc_redesign', { EXTERNAL_IMAGE_HOSTS: 'upload.wikimedia.org' });
    await seedServiceArea(h.models);
    biryani = await seedRestaurant(h.models, {
      name: 'Biryani Bros',
      location: northOf(drop, 1),
      cuisines: ['biryani', 'mughlai'],
      address: { line1: '1 Main', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' },
      images: { cover: 'https://upload.wikimedia.org/biryani.jpg', logo: 'https://evil.example/logo.png' },
    });
    dosa = await seedRestaurant(h.models, { name: 'Dosa Den', location: northOf(drop, 2), cuisines: ['south-indian'] });
    declaredMixed = await seedRestaurant(h.models, { name: 'Declared Mixed', location: northOf(drop, 3), cuisines: ['biryani'], pureVeg: false });
    paused = await seedRestaurant(h.models, { name: 'Kettle & Bun', location: northOf(drop, 0.5), cuisines: ['cafe'], pausedUntil: new Date(Date.now() + 3600_000) });
    await addItem(h, biryani, { name: 'Chicken Biryani', isVeg: false, available: false, pricePaise: 30000 });
    await addItem(h, biryani, { name: 'Veg Biryani', isVeg: true, pricePaise: 25000 });
    await addItem(h, dosa, { name: 'Masala Dosa', pricePaise: 9000 });
    await addItem(h, declaredMixed, { name: 'Paneer Tikka', pricePaise: 22000 });
    await addItem(h, paused, { name: 'Bun Maska', pricePaise: 6000 });
  });
  afterAll(async () => h?.close());

  const list = (q: Record<string, unknown> = {}) => request(h.app).get('/api/v1/discovery/restaurants').query({ ...drop, ...q });
  const byId = (items: { id: string }[], id: string) => items.find((i) => i.id === id) as Record<string, unknown>;

  it('counts {total, open} ignore openNow/pagination; facets ignore the cuisine filter', async () => {
    const res = await list({ limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.counts).toEqual({ total: 4, open: 3 });
    expect(res.body.facets.cuisines).toEqual([
      { slug: 'biryani', count: 2 },
      { slug: 'cafe', count: 1 },
      { slug: 'mughlai', count: 1 },
      { slug: 'south-indian', count: 1 },
    ]);
    const open = await list({ openNow: 'true' });
    expect(open.body.counts).toEqual({ total: 4, open: 3 });
    expect(open.body.items.map((i: { id: string }) => i.id)).not.toContain(paused);
    const cuisine = await list({ cuisine: 'biryani' });
    expect(cuisine.body.counts).toEqual({ total: 2, open: 2 });
    expect(cuisine.body.facets.cuisines).toHaveLength(4);
    const veg = await list({ veg: 'true' });
    expect(veg.body.facets.cuisines).toEqual([
      { slug: 'cafe', count: 1 },
      { slug: 'south-indian', count: 1 },
    ]);
  });

  it('paused restaurant is listed after open ones as "Not accepting orders"', async () => {
    const res = await list();
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids[ids.length - 1]).toBe(paused); // nearest, but closed → last
    expect(byId(res.body.items, paused)).toMatchObject({ open: false, closedReason: 'PAUSED', acceptingOrders: false });
    const page = await request(h.app).get(`/api/v1/restaurants/${paused}`).query(drop);
    expect(page.body.restaurant).toMatchObject({ open: false, closedReason: 'PAUSED', acceptingOrders: false, closesAt: null });
    expect(page.body.delivery).toMatchObject({ deliverable: false, reason: 'PAUSED' });
  });

  it('veg: declared flag wins; undeclared derives from the WHOLE menu (unavailable non-veg still counts)', async () => {
    const res = await list();
    expect(byId(res.body.items, biryani).isVeg).toBe('MIXED');
    expect(byId(res.body.items, dosa).isVeg).toBe('PURE_VEG');
    expect(byId(res.body.items, declaredMixed).isVeg).toBe('MIXED');
    expect((await list({ veg: 'true' })).body.items.map((i: { id: string }) => i.id).sort()).toEqual([dosa, paused].sort());
    // price band from AVAILABLE items only: biryani avg = 25000 → band 2
    expect(byId(res.body.items, biryani).priceBand).toBe(2);
  });

  it('locality + allowlisted external image URLs (non-allowlisted → null)', async () => {
    const res = await list();
    expect(byId(res.body.items, biryani)).toMatchObject({ locality: 'Indiranagar', imageUrl: 'https://upload.wikimedia.org/biryani.jpg' });
    expect(byId(res.body.items, dosa).locality).toBeNull();
    const page = await request(h.app).get(`/api/v1/restaurants/${biryani}`);
    expect(page.body.restaurant).toMatchObject({
      locality: 'Indiranagar',
      address: { line1: '1 Main', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' },
      imageUrl: 'https://upload.wikimedia.org/biryani.jpg',
      logoUrl: null,
    });
    const internal = await request(h.app).get(`/internal/restaurants/${biryani}`).set(bearer(await h.internalToken('orders')));
    expect(internal.status).toBe(200);
    expect(internal.body).toMatchObject({
      address: { locality: 'Indiranagar' },
      pureVeg: false,
      images: { coverUrl: 'https://upload.wikimedia.org/biryani.jpg', logoUrl: null },
    });
    const internalDosa = await request(h.app).get(`/internal/restaurants/${dosa}`).set(bearer(await h.internalToken('delivery')));
    expect(internalDosa.body.pureVeg).toBe(true);
  });

  it('closesAt for an open restaurant with a closing time (clock-controlled)', async () => {
    const id = await seedRestaurant(h.models, {
      name: 'Late Night',
      location: northOf(drop, 1.5),
      hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '18:00', close: '02:00' })),
    });
    h.clock.now = ist('2026-10-12T22:00:00');
    try {
      const res = await list();
      expect(byId(res.body.items, id)).toMatchObject({ open: true, closesAt: ist('2026-10-13T02:00:00').toISOString(), closedReason: null });
      const page = await request(h.app).get(`/api/v1/restaurants/${id}`);
      expect(page.body.restaurant.closesAt).toBe(ist('2026-10-13T02:00:00').toISOString());
      h.clock.now = ist('2026-10-12T12:00:00');
      const closed = byId((await list()).body.items, id);
      expect(closed).toMatchObject({ open: false, closedReason: 'OUTSIDE_HOURS', closesAt: null, nextOpenAt: ist('2026-10-12T18:00:00').toISOString() });
    } finally {
      h.clock.now = null;
      await h.models.Restaurant.deleteOne({ _id: id });
    }
  });

  it('restaurants without menuStats are healed once (persisted) by discovery', async () => {
    const fresh = await h.models.Restaurant.findById(dosa).lean();
    expect(fresh?.menuStats).toMatchObject({ itemCount: 1, availableItemCount: 1, nonVegCount: 0, avgItemPricePaise: 9000, priceBand: 1 });
  });

  it('offer badge: best live restaurant-scoped coupon (MKT-8); unscoped coupons never badge', async () => {
    const base = { description: '', minOrderPaise: 0, validFrom: new Date(Date.now() - 86400000), validTo: new Date(Date.now() + 86400000), totalLimit: null, perUserLimit: 1, active: true };
    await h.models.Coupon.create([
      { ...base, code: 'BIRY20', type: 'PERCENT', valueBps: 2000, restaurantIds: [biryani], badgeLabel: '20% OFF' },
      { ...base, code: 'BIRY10', type: 'PERCENT', valueBps: 1000, restaurantIds: [biryani, dosa] },
      { ...base, code: 'ALL50', type: 'FLAT', valuePaise: 50000, badgeLabel: 'BIG' },
      { ...base, code: 'OLD', type: 'FLAT', valuePaise: 90000, restaurantIds: [declaredMixed], active: false },
    ]);
    const res = await list();
    expect(byId(res.body.items, biryani).offer).toEqual({ label: '20% OFF', code: 'BIRY20' });
    expect(byId(res.body.items, dosa).offer).toEqual({ label: '10% OFF', code: 'BIRY10' });
    expect(byId(res.body.items, declaredMixed).offer).toBeNull();
    expect(byId(res.body.items, paused).offer).toBeNull();
  });

  it('item search goes through the menu_items text index', async () => {
    const res = await list({ q: 'biryani' });
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(biryani);
    const plan = await h.models.MenuItem.find({ $text: { $search: 'dosa' }, restaurantId: { $in: [new Types.ObjectId(dosa)] }, available: true }).explain('queryPlanner');
    expect(JSON.stringify(plan)).toMatch(/TEXT/);
  });
});

describe('menuStats maintained by menu writes (MKT-13) + recomputeMenuStats', () => {
  let h: Harness;
  let token: string;
  let rid: string;
  let catId: string;
  beforeAll(async () => {
    h = await createHarness('menu_stats');
    token = await h.ownerToken();
    rid = (await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Stats House' })).body.restaurant.id;
    catId = (await request(h.app).post(`/api/v1/owner/restaurants/${rid}/categories`).set(bearer(token)).send({ name: 'All' })).body.id;
  });
  afterAll(async () => h?.close());
  const stats = async () => (await h.models.Restaurant.findById(rid).lean())?.menuStats;
  const url = (p: string) => `/api/v1/owner/restaurants/${rid}${p}`;

  it('create / availability / patch / delete keep the stats current', async () => {
    const a = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Dal', pricePaise: 10000, isVeg: true });
    expect(a.status).toBe(201);
    expect(await stats()).toMatchObject({ itemCount: 1, availableItemCount: 1, nonVegCount: 0, avgItemPricePaise: 10000, priceBand: 1 });
    const b = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Mutton', pricePaise: 50000, isVeg: false });
    expect(await stats()).toMatchObject({ itemCount: 2, availableItemCount: 2, nonVegCount: 1, avgItemPricePaise: 30000, priceBand: 2 });
    await request(h.app).patch(url(`/items/${b.body.id}/availability`)).set(bearer(token)).send({ available: false }).expect(200);
    expect(await stats()).toMatchObject({ itemCount: 2, availableItemCount: 1, nonVegCount: 1, avgItemPricePaise: 10000, priceBand: 1 });
    await request(h.app).patch(url(`/items/${a.body.id}`)).set(bearer(token)).send({ pricePaise: 45000 }).expect(200);
    expect(await stats()).toMatchObject({ avgItemPricePaise: 45000, priceBand: 3 });
    await request(h.app).delete(url(`/items/${b.body.id}`)).set(bearer(token)).expect(204);
    expect(await stats()).toMatchObject({ itemCount: 1, nonVegCount: 0 });
  });

  it('a veg item with a non-veg option counts as non-veg', async () => {
    await request(h.app)
      .post(url('/items'))
      .set(bearer(token))
      .send({ categoryId: catId, name: 'Fried Rice', pricePaise: 15000, isVeg: true, customizationGroups: [{ name: 'Add', minSelect: 0, maxSelect: 1, options: [{ name: 'Egg', pricePaise: 2000, isVeg: false }] }] })
      .expect(201);
    expect((await stats())?.nonVegCount).toBe(1);
  });

  it('recomputeMenuStats(conn) after bulk inserts (all restaurants, incl. ones with no items)', async () => {
    const other = await seedRestaurant(h.models, { name: 'Bulk' });
    const empty = await seedRestaurant(h.models, { name: 'Empty' });
    await h.models.MenuItem.insertMany([
      { restaurantId: other, categoryId: new Types.ObjectId(), name: 'A', pricePaise: 10000, isVeg: true },
      { restaurantId: other, categoryId: new Types.ObjectId(), name: 'B', pricePaise: 30000, isVeg: true, available: false },
    ]);
    const n = await recomputeMenuStats(h.db.conn);
    expect(n).toBeGreaterThanOrEqual(3);
    expect((await h.models.Restaurant.findById(other).lean())?.menuStats).toMatchObject({ itemCount: 2, availableItemCount: 1, avgItemPricePaise: 10000, priceBand: 1 });
    expect((await h.models.Restaurant.findById(empty).lean())?.menuStats).toMatchObject({ itemCount: 0, priceBand: null, avgItemPricePaise: null });
    expect(await recomputeMenuStats(h.db.conn, other)).toBe(1);
  });
});

describe('pure veg (MKT-4), featured (MKT-9), unavailableReason (MKT-6), locality write (MKT-5)', () => {
  let h: Harness;
  let token: string;
  let rid: string;
  let catId: string;
  beforeAll(async () => {
    h = await createHarness('pure_veg');
    await seedServiceArea(h.models);
    token = await h.ownerToken();
    rid = (await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Green Leaf', pureVeg: true })).body.restaurant.id;
    catId = (await request(h.app).post(`/api/v1/owner/restaurants/${rid}/categories`).set(bearer(token)).send({ name: 'All' })).body.id;
  });
  afterAll(async () => h?.close());
  const url = (p = '') => `/api/v1/owner/restaurants/${rid}${p}`;

  it('owner view carries pureVeg; non-veg item or option in a pure-veg restaurant → 422 PURE_VEG_VIOLATION', async () => {
    expect((await request(h.app).get(url()).set(bearer(token))).body.pureVeg).toBe(true);
    const bad = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Chicken', pricePaise: 10000, isVeg: false });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('PURE_VEG_VIOLATION');
    const badOpt = await request(h.app)
      .post(url('/items'))
      .set(bearer(token))
      .send({ categoryId: catId, name: 'Rice', pricePaise: 10000, isVeg: true, customizationGroups: [{ name: 'Add', minSelect: 0, maxSelect: 1, options: [{ name: 'Egg', pricePaise: 1000, isVeg: false }] }] });
    expect(badOpt.status).toBe(422);
    const ok = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Rice', pricePaise: 10000, isVeg: true });
    expect(ok.status).toBe(201);
    const patch = await request(h.app).patch(url(`/items/${ok.body.id}`)).set(bearer(token)).send({ isVeg: false });
    expect(patch.status).toBe(422);
    expect(patch.body.error.details).toEqual({ itemId: ok.body.id });
  });

  it('setting pureVeg=true while non-veg items exist → 422 with the offending ids; admin override follows the same rule', async () => {
    await request(h.app).patch(url()).set(bearer(token)).send({ pureVeg: false }).expect(200);
    const meat = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Mutton', pricePaise: 30000, isVeg: false });
    expect(meat.status).toBe(201);
    const res = await request(h.app).patch(url()).set(bearer(token)).send({ pureVeg: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'PURE_VEG_VIOLATION', details: { itemIds: [meat.body.id], optionIds: [] } });
    const admin = await h.adminToken();
    const adm = await request(h.app).patch(`/api/v1/admin/marketplace/restaurants/${rid}`).set(bearer(admin)).send({ pureVeg: true });
    expect(adm.status).toBe(422);
    await request(h.app).delete(url(`/items/${meat.body.id}`)).set(bearer(token)).expect(204);
    const adm2 = await request(h.app).patch(`/api/v1/admin/marketplace/restaurants/${rid}`).set(bearer(admin)).send({ pureVeg: true });
    expect(adm2.status).toBe(200);
    expect(adm2.body.pureVeg).toBe(true);
  });

  it('featured: max 6 per restaurant (7th → 422 VALIDATION_FAILED); page returns recommended (available first)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: `Dish ${i}`, pricePaise: 10000 + i, isVeg: true, featured: true });
      expect(r.status).toBe(201);
      expect(r.body.featured).toBe(true);
      ids.push(r.body.id);
    }
    const seventh = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Dish 7', pricePaise: 10000, isVeg: true, featured: true });
    expect(seventh.status).toBe(400);
    expect(seventh.body.error.code).toBe('VALIDATION_FAILED');
    const plain = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Dish 8', pricePaise: 10000, isVeg: true });
    expect((await request(h.app).patch(url(`/items/${plain.body.id}`)).set(bearer(token)).send({ featured: true })).status).toBe(400);
    // re-saving an already featured item is fine
    expect((await request(h.app).patch(url(`/items/${ids[0]}`)).set(bearer(token)).send({ featured: true, name: 'Dish 0!' })).status).toBe(200);

    await request(h.app).patch(url(`/items/${ids[0]}/availability`)).set(bearer(token)).send({ available: false }).expect(200);
    await h.models.Restaurant.updateOne({ _id: rid }, { $set: { status: 'APPROVED' } });
    const page = await request(h.app).get(`/api/v1/restaurants/${rid}`);
    expect(page.status).toBe(200);
    expect(page.body.recommended).toHaveLength(6);
    expect(page.body.recommended[5]).toMatchObject({ id: ids[0], available: false, unavailableReason: 'UNAVAILABLE', featured: true });
    expect(page.body.restaurant).toMatchObject({ pureVeg: true, isVeg: 'PURE_VEG' });
  });

  it('unavailableReason SOLD_OUT vs UNAVAILABLE and stockLeft (≤ 5 only)', async () => {
    const sold = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Sold', pricePaise: 10000, isVeg: true, trackStock: true, stockQty: 0 });
    const few = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Few', pricePaise: 10000, isVeg: true, trackStock: true, stockQty: 3 });
    const many = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'Many', pricePaise: 10000, isVeg: true, trackStock: true, stockQty: 50 });
    const page = await request(h.app).get(`/api/v1/restaurants/${rid}`);
    const items = page.body.menu.flatMap((c: { items: unknown[] }) => c.items) as { id: string }[];
    const get = (id: string) => items.find((i) => i.id === id);
    expect(get(sold.body.id)).toMatchObject({ available: false, unavailableReason: 'SOLD_OUT', stockLeft: 0 });
    expect(get(few.body.id)).toMatchObject({ available: true, unavailableReason: null, stockLeft: 3 });
    expect(get(many.body.id)).toMatchObject({ available: true, unavailableReason: null, stockLeft: null });
  });

  it('owner PATCH address.locality shows in the owner view and public page', async () => {
    const res = await request(h.app)
      .patch(url())
      .set(bearer(token))
      .send({ address: { line1: '5 CMH Road', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' } });
    expect(res.status).toBe(200);
    expect(res.body.address).toEqual({ line1: '5 CMH Road', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' });
    const page = await request(h.app).get(`/api/v1/restaurants/${rid}`);
    expect(page.body.restaurant.locality).toBe('Indiranagar');
  });
});

describe('discovery listing cache (MKT-13)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness('disc_cache', { DISCOVERY_CACHE_TTL_SEC: '60' });
    await seedServiceArea(h.models);
    await seedRestaurant(h.models, { name: 'First', location: northOf(drop, 1) });
    await seedRestaurant(h.models, { name: 'Second', location: northOf(drop, 2) });
  });
  afterAll(async () => h?.close());
  const names = async (q: Record<string, unknown> = {}) =>
    (await request(h.app).get('/api/v1/discovery/restaurants').query({ ...drop, ...q })).body.items.map((i: { name: string }) => i.name);

  it('the ordered id list is reused within the TTL (same geohash-7 cell + filters) and rebuilt after an epoch bump', async () => {
    expect(await names()).toEqual(['First', 'Second']);
    expect(await h.tr.redis.keys(`${h.tr.prefix}disc:list:*`)).toHaveLength(1); // REDIS_KEY_PREFIX applied
    const third = await seedRestaurant(h.models, { name: 'Third', location: northOf(drop, 0.5) });
    expect(await names()).toEqual(['First', 'Second']); // cached order
    expect(await names({ lat: drop.lat + 0.0001, lng: drop.lng + 0.0001 })).toEqual(['First', 'Second']); // ~15 m away: same cell
    expect(await names({ sort: 'eta' })).toEqual(['Third', 'First', 'Second']); // different filters → own entry
    // pages hydrate fresh: a restaurant that stopped qualifying disappears without waiting for the TTL
    await h.models.Restaurant.updateOne({ _id: third }, { $set: { status: 'SUSPENDED' } });
    expect(await names({ sort: 'eta' })).toEqual(['First', 'Second']);
    await h.models.Restaurant.updateOne({ _id: third }, { $set: { status: 'APPROVED' } });
    await bumpDiscoveryEpoch(h.tr.redis);
    expect(await names()).toEqual(['Third', 'First', 'Second']);
  });

  it('owner pause bumps the epoch (next listing reflects it)', async () => {
    const owner = newId();
    const id = await seedRestaurant(h.models, { name: 'Zeroth', ownerUserId: owner, location: northOf(drop, 0.2) });
    await bumpDiscoveryEpoch(h.tr.redis);
    expect((await names())[0]).toBe('Zeroth');
    await request(h.app).post(`/api/v1/owner/restaurants/${id}/pause`).set(bearer(await h.ownerToken(owner))).send({ minutes: 30 }).expect(200);
    const after = await names();
    expect(after[after.length - 1]).toBe('Zeroth');
  });
});
