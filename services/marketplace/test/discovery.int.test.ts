import request from 'supertest';
import { computeDeliveryFee } from '@thali/pricing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newId, northOf, seedRestaurant, seedServiceArea, type Harness } from './helpers.js';

let h: Harness;
const drop = { lat: 12.95, lng: 77.62 };
const rule = { basePaise: 2000, baseKm: 2, perKmPaise: 500, maxPaise: 8000 };
let near: string; // approved, ~1 km, inside radius
let far: string; // approved, ~8 km straight-line, outside 6 km radius ("nearby" but not deliverable)
let pendingInside: string; // APPROVAL_PENDING inside radius

async function addItem(restaurantId: string, fields: Record<string, unknown>) {
  const cat = await h.models.MenuCategory.create({ restaurantId, name: 'Mains', sortOrder: 1, active: true });
  await h.models.MenuItem.create({
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
}

beforeAll(async () => {
  h = await createHarness('discovery');
  await seedServiceArea(h.models);
  near = await seedRestaurant(h.models, { name: 'Near Thali', location: northOf(drop, 1), cuisines: ['thali'], avgPrepMinutes: 40 });
  far = await seedRestaurant(h.models, { name: 'Far Biryani', location: northOf(drop, 8), cuisines: ['biryani'] });
  pendingInside = await seedRestaurant(h.models, { name: 'Pending Place', status: 'APPROVAL_PENDING', location: northOf(drop, 0.5) });
  await addItem(near, { name: 'Paneer Butter Masala', isVeg: true, pricePaise: 25000 });
  await addItem(far, { name: 'Chicken Biryani', isVeg: false });
});
afterAll(async () => h?.close());

const discover = (q: Record<string, unknown>) => request(h.app).get('/api/v1/discovery/restaurants').query({ ...drop, ...q });

describe('discovery: nearby ≠ deliverable', () => {
  it('returns only approved restaurants inside an active area AND within their delivery radius', async () => {
    const res = await discover({});
    expect(res.status).toBe(200);
    expect(res.body.serviceable).toBe(true);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
    expect(ids).not.toContain(pendingInside);
  });

  it('item shape: real distance/fee/ETA from the geo provider, labelled source, isDemo, null rating', async () => {
    const res = await discover({});
    const item = res.body.items.find((i: { id: string }) => i.id === near);
    expect(item).toMatchObject({
      id: near,
      name: 'Near Thali',
      cuisines: ['thali'],
      open: true,
      isVeg: 'PURE_VEG',
      etaSource: 'DEMO_HAVERSINE',
      rating: null,
      isDemo: false,
      imageUrl: null,
      priceBand: 2,
    });
    expect(item.slug).toEqual(expect.any(String));
    expect(item.distanceKm).toBeCloseTo(1.3, 1); // haversine 1 km × road factor 1.3
    expect(item.deliveryFeePaise).toBe(computeDeliveryFee(item.distanceKm, rule));
    expect(item.etaMinutes).toBe(40 + Math.ceil((item.distanceKm / 20) * 60)); // prep + travel
    expect(res.body.serviceArea).toMatchObject({ name: 'Bengaluru Central', minOrderPaise: 10000 });
  });

  it('restaurant within radius but OUTSIDE the drop’s service-area polygon is not deliverable (list + page)', async () => {
    // area spans lat 12.90–13.05; drop just inside the southern edge, restaurant ~2.2 km south of it (outside)
    const edgeDrop = { lat: 12.91, lng: 77.62 };
    const outside = await seedRestaurant(h.models, { name: 'Across The Border', location: { lat: 12.89, lng: 77.62 } });
    const inside = await seedRestaurant(h.models, { name: 'Edge Inside', location: { lat: 12.92, lng: 77.62 } });
    const res = await request(h.app).get('/api/v1/discovery/restaurants').query(edgeDrop);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(outside);

    const page = await request(h.app).get(`/api/v1/restaurants/${outside}`).query(edgeDrop);
    expect(page.status).toBe(200);
    expect(page.body.delivery).toMatchObject({ deliverable: false, reason: 'OUTSIDE_SERVICE_AREA' });
    const pageIn = await request(h.app).get(`/api/v1/restaurants/${inside}`).query(edgeDrop);
    expect(pageIn.body.delivery).toMatchObject({ deliverable: true });

    const search = await request(h.app).get('/api/v1/discovery/search').query({ ...edgeDrop, q: 'border' });
    expect(search.body.restaurants).toEqual([]);
  });

  it('drop outside every active area → {items:[], serviceable:false}', async () => {
    const res = await request(h.app).get('/api/v1/discovery/restaurants').query({ lat: 19.07, lng: 72.87 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], serviceable: false });
    const sv = await request(h.app).get('/api/v1/discovery/serviceability').query({ lat: 19.07, lng: 72.87 });
    expect(sv.body).toEqual({ serviceable: false, area: null });
  });

  it('inactive service areas do not count', async () => {
    const h2 = await createHarness('discovery_inactive');
    try {
      await seedServiceArea(h2.models, { active: false });
      await seedRestaurant(h2.models, { location: northOf(drop, 1) });
      const res = await request(h2.app).get('/api/v1/discovery/restaurants').query(drop);
      expect(res.body).toMatchObject({ items: [], serviceable: false });
    } finally {
      await h2.close();
    }
  });

  it('lat/lng are required and validated', async () => {
    expect((await request(h.app).get('/api/v1/discovery/restaurants')).status).toBe(400);
    expect((await request(h.app).get('/api/v1/discovery/restaurants').query({ lat: 200, lng: 77 })).status).toBe(400);
  });
});

describe('discovery filters, sorting, rating, search', () => {
  let a: string; // 0.5 km, prep 50 (slow), non-veg
  let b: string; // 2.5 km, prep 10 (fast), pure veg, south-indian
  let c: string; // 4 km, prep 15
  let h3: Harness;
  beforeAll(async () => {
    h3 = await createHarness('discovery_sort');
    await seedServiceArea(h3.models);
    a = await seedRestaurant(h3.models, { name: 'Alpha Kitchen', location: northOf(drop, 0.5), avgPrepMinutes: 50, cuisines: ['north-indian'], ratingSum: 22, ratingCount: 5 });
    b = await seedRestaurant(h3.models, { name: 'Bravo Dosa', location: northOf(drop, 2.5), avgPrepMinutes: 10, cuisines: ['south-indian'], ratingSum: 4, ratingCount: 4 });
    c = await seedRestaurant(h3.models, { name: 'Charlie Cafe', location: northOf(drop, 4), avgPrepMinutes: 15, cuisines: ['cafe'], ratingSum: 30, ratingCount: 6 });
    const add = async (restaurantId: string, name: string, isVeg: boolean, pricePaise = 15000) => {
      const cat = await h3.models.MenuCategory.create({ restaurantId, name: 'All', sortOrder: 1, active: true });
      await h3.models.MenuItem.create({ restaurantId, categoryId: cat._id, name, pricePaise, isVeg, available: true, trackStock: false, stockQty: 0, reservedQty: 0, customizationGroups: [], tags: [] });
    };
    await add(a, 'Butter Chicken', false, 45000);
    await add(a, 'Dal Makhani', true, 30000);
    await add(b, 'Masala Dosa', true, 9000);
    await add(c, 'Cold Coffee', true, 15000);
    await add(c, 'Paneer Sandwich', true, 15000);
  });
  afterAll(async () => h3?.close());

  const ids = async (q: Record<string, unknown>) => {
    const res = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, ...q });
    expect(res.status).toBe(200);
    return res.body.items.map((i: { id: string }) => i.id) as string[];
  };

  it('sort by distance (default), deliveryFee, eta', async () => {
    expect(await ids({})).toEqual([a, b, c]);
    expect(await ids({ sort: 'distance' })).toEqual([a, b, c]);
    expect(await ids({ sort: 'deliveryFee' })).toEqual([a, b, c]);
    // eta = prep + travel: a = 50 + 2, b = 10 + 10, c = 15 + 16
    expect(await ids({ sort: 'eta' })).toEqual([b, c, a]);
  });

  it('rating is null when fewer than 5 ratings; rating sort puts rated first, "new" last', async () => {
    const res = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, sort: 'rating' });
    const byId = Object.fromEntries(res.body.items.map((i: { id: string; rating: unknown }) => [i.id, i.rating]));
    expect(byId[a]).toEqual({ average: 4.4, count: 5 });
    expect(byId[b]).toBeNull();
    expect(byId[c]).toEqual({ average: 5, count: 6 });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([c, a, b]);
  });

  it('veg filter (pure veg only) and cuisine filter', async () => {
    expect(await ids({ veg: 'true' })).toEqual([b, c]);
    expect(await ids({ cuisine: 'south-indian' })).toEqual([b]);
    expect(await ids({ cuisine: 'south-indian,cafe' })).toEqual([b, c]);
  });

  it('priceBand filter and openNow filter', async () => {
    expect(await ids({ priceBand: '1' })).toEqual([b, c]);
    expect(await ids({ priceBand: '2,3' })).toEqual([a]);
    await h3.models.Restaurant.updateOne({ _id: b }, { $set: { hours: [{ day: 0, open: '00:00', close: '00:01' }] } });
    try {
      const res = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop });
      const bravo = res.body.items.find((i: { id: string }) => i.id === b);
      expect(bravo.open).toBe(false);
      expect(bravo.nextOpenAt).toEqual(expect.any(String));
      expect(await ids({ openNow: 'true' })).toEqual([a, c]);
    } finally {
      await h3.models.Restaurant.updateOne({ _id: b }, { $set: { hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '00:00' })) } });
    }
  });

  // ADR-34 (design overrules PRD C-2): paused restaurants are LISTED as "Not accepting orders", after open ones
  it('paused restaurants are listed last with closedReason PAUSED; openNow excludes them', async () => {
    const until = new Date(Date.now() + 3600_000);
    await h3.models.Restaurant.updateOne({ _id: a }, { $set: { pausedUntil: until } });
    try {
      expect(await ids({})).toEqual([b, c, a]);
      const res = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop });
      const alpha = res.body.items.find((i: { id: string }) => i.id === a);
      expect(alpha).toMatchObject({ open: false, closedReason: 'PAUSED', acceptingOrders: false, pausedUntil: until.toISOString(), closesAt: null });
      const bravo = res.body.items.find((i: { id: string }) => i.id === b);
      expect(bravo).toMatchObject({ open: true, closedReason: null, acceptingOrders: true, pausedUntil: null });
      expect(res.body.counts).toEqual({ total: 3, open: 2 });
      expect(await ids({ openNow: 'true' })).toEqual([b, c]);
    } finally {
      await h3.models.Restaurant.updateOne({ _id: a }, { $unset: { pausedUntil: 1 } });
    }
  });

  it('text search matches item names → restaurant included with matchedItems', async () => {
    const res = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, q: 'paneer' });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([c]);
    expect(res.body.items[0].matchedItems).toEqual([expect.objectContaining({ name: 'Paneer Sandwich', pricePaise: 15000, isVeg: true })]);

    const byName = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, q: 'bravo' });
    expect(byName.body.items.map((i: { id: string }) => i.id)).toEqual([b]);
    expect(byName.body.items[0].matchedItems).toEqual([]);

    const s = await request(h3.app).get('/api/v1/discovery/search').query({ ...drop, q: 'dosa' });
    expect(s.status).toBe(200);
    expect(s.body.serviceable).toBe(true);
    expect(s.body.restaurants.map((i: { id: string }) => i.id)).toEqual([b]);
    expect(s.body.items).toEqual([expect.objectContaining({ name: 'Masala Dosa', restaurantId: b, restaurantName: 'Bravo Dosa' })]);

    // regex metacharacters are treated literally
    expect((await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, q: '.*' })).body.items).toEqual([]);
  });

  it('cursor pagination over the sorted list', async () => {
    const p1 = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, limit: 2 });
    expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual([a, b]);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await request(h3.app).get('/api/v1/discovery/restaurants').query({ ...drop, limit: 2, cursor: p1.body.nextCursor });
    expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual([c]);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('public restaurant page by id or slug: menu, open status, delivery estimate for the drop', async () => {
    const r = await request(h3.app).get(`/api/v1/restaurants/${a}`).query(drop);
    expect(r.status).toBe(200);
    expect(r.body.restaurant).toMatchObject({ id: a, name: 'Alpha Kitchen', open: true, rating: { average: 4.4, count: 5 } });
    expect(r.body.delivery).toMatchObject({ deliverable: true, etaSource: 'DEMO_HAVERSINE' });
    expect(r.body.menu.map((c: { name: string }) => c.name)).toEqual(['All', 'All']); // fixture: one category per item
    expect(r.body.menu.flatMap((c: { items: unknown[] }) => c.items)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Butter Chicken', isVeg: false, available: true, pricePaise: 45000 })]),
    );
    const bySlug = await request(h3.app).get(`/api/v1/restaurants/${r.body.restaurant.slug}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.delivery).toBeNull();
    expect((await request(h3.app).get(`/api/v1/restaurants/${newId()}`)).status).toBe(404);
  });
});
