/** POST /internal/quote (LLD §8 step 2) — prices from DB, open/serviceable reuse, selection validation (Review Focus #5). */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, northOf, seedRestaurant, seedServiceArea, type Harness } from './helpers.js';
import { oid, seedCategory, seedItem } from './commerce-helpers.js';

let h: Harness;
let tok: string;
const loc = { lat: 12.9716, lng: 77.6412 };
const drop = northOf(loc, 2);
let rid: string;
let pizza: string;
let naan: string;
let size: { id: string; regular: string; large: string };
let addons: { id: string; cheese: string; olives: string; jalapeno: string };

const quote = (body: object, token = tok) => request(h.app).post('/internal/quote').set(bearer(token)).send(body);

beforeAll(async () => {
  h = await createHarness('quote');
  tok = await h.internalToken('orders');
  await seedServiceArea(h.models);
  rid = await seedRestaurant(h.models, { location: loc, packagingFeePaise: 1000, avgPrepMinutes: 15 });
  pizza = await seedItem(h, rid, {
    name: 'Margherita',
    pricePaise: 25000,
    customizationGroups: [
      { name: 'Size', minSelect: 1, maxSelect: 1, options: [{ name: 'Regular', pricePaise: 0, isVeg: true }, { name: 'Large', pricePaise: 5000, isVeg: true }] },
      {
        name: 'Add-ons',
        minSelect: 0,
        maxSelect: 1,
        options: [
          { name: 'Cheese', pricePaise: 3000, isVeg: true },
          { name: 'Olives', pricePaise: 2000, isVeg: true },
          { name: 'Jalapeño', pricePaise: 2000, isVeg: true, available: false },
        ],
      },
    ],
  });
  naan = await seedItem(h, rid, { name: 'Butter Naan', pricePaise: 4000 });
  const doc = (await h.models.MenuItem.findById(pizza).lean())!;
  const [g1, g2] = doc.customizationGroups as unknown as { _id: unknown; options: { _id: unknown }[] }[];
  size = { id: String(g1!._id), regular: String(g1!.options[0]!._id), large: String(g1!.options[1]!._id) };
  addons = { id: String(g2!._id), cheese: String(g2!.options[0]!._id), olives: String(g2!.options[1]!._id), jalapeno: String(g2!.options[2]!._id) };
});
afterAll(async () => h?.close());

const large = () => [{ groupId: size.id, optionIds: [size.large] }];

describe('POST /internal/quote', () => {
  it('prices come from the DB (client prices ignored), add-ons included, lines in request order', async () => {
    const res = await quote({
      drop,
      items: [
        { restaurantId: rid, itemId: pizza, quantity: 1, selections: [...large(), { groupId: addons.id, optionIds: [addons.cheese] }], unitPricePaise: 1 },
        { restaurantId: rid, itemId: naan, quantity: 2, selections: [] },
        { restaurantId: rid, itemId: pizza, quantity: 1, selections: [{ groupId: size.id, optionIds: [size.regular] }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    expect(res.body.restaurants).toHaveLength(1);
    const r = res.body.restaurants[0];
    expect(r).toMatchObject({ restaurantId: rid, open: true, serviceable: true, packagingFeePaise: 1000, etaSource: 'DEMO_HAVERSINE' });
    expect(typeof r.ownerUserId).toBe('string');
    expect(r.location).toEqual(loc);
    expect(r.deliveryFeePaise).toBeGreaterThanOrEqual(2000);
    expect(r.distanceKm).toBeGreaterThan(0);
    expect(r.etaMinutes).toBeGreaterThan(15);
    expect(r.lines.map((l: { itemId: string }) => l.itemId)).toEqual([pizza, naan, pizza]);
    expect(r.lines[0]).toMatchObject({ name: 'Margherita', isVeg: true, unitPricePaise: 25000, available: true, stockOk: true });
    expect(r.lines[0].addOns).toEqual([
      { id: size.large, name: 'Large', pricePaise: 5000 },
      { id: addons.cheese, name: 'Cheese', pricePaise: 3000 },
    ]);
    expect(r.lines[1]).toMatchObject({ unitPricePaise: 4000, addOns: [] });
    expect(r.lines[2].addOns).toEqual([{ id: size.regular, name: 'Regular', pricePaise: 0 }]);
  });

  it('echoes lineRef on every returned line (same item twice with different selections)', async () => {
    const res = await quote({
      drop,
      items: [
        { lineRef: 'line-a', restaurantId: rid, itemId: pizza, quantity: 1, selections: large() },
        { lineRef: 'line-b', restaurantId: rid, itemId: pizza, quantity: 2, selections: [{ groupId: size.id, optionIds: [size.regular] }] },
        { restaurantId: rid, itemId: naan, quantity: 1, selections: [] },
        { lineRef: 'line-c', restaurantId: rid, itemId: pizza, quantity: 1, selections: [] },
      ],
    });
    expect(res.status).toBe(200);
    const lines = res.body.restaurants[0].lines;
    expect(lines.map((l: { lineRef?: string }) => l.lineRef ?? null)).toEqual(['line-a', 'line-b', null, 'line-c']);
    expect(lines[0].addOns[0].name).toBe('Large');
    expect(lines[1].addOns[0].name).toBe('Regular');
    // problems carry the lineRef of the offending line too
    expect(res.body.problems).toEqual([expect.objectContaining({ code: 'INVALID_SELECTION', itemId: pizza, lineRef: 'line-c' })]);
  });

  it('closed (paused) restaurant → RESTAURANT_CLOSED problem', async () => {
    const closed = await seedRestaurant(h.models, { location: loc, pausedUntil: new Date(Date.now() + 3600_000) });
    const it1 = await seedItem(h, closed);
    const res = await quote({ drop, items: [{ restaurantId: closed, itemId: it1, quantity: 1, selections: [] }] });
    expect(res.status).toBe(200);
    expect(res.body.restaurants[0]).toMatchObject({ restaurantId: closed, open: false });
    expect(res.body.problems).toEqual([expect.objectContaining({ code: 'RESTAURANT_CLOSED', restaurantId: closed })]);
  });

  it('outside opening hours → RESTAURANT_CLOSED', async () => {
    const r2 = await seedRestaurant(h.models, { location: loc, hours: [] });
    const i2 = await seedItem(h, r2);
    const res = await quote({ drop, items: [{ restaurantId: r2, itemId: i2, quantity: 1, selections: [] }] });
    expect(res.body.problems.map((p: { code: string }) => p.code)).toContain('RESTAURANT_CLOSED');
  });

  it('unavailable / unknown / inactive-category items → ITEM_UNAVAILABLE', async () => {
    const off = await seedItem(h, rid, { available: false });
    const hiddenCat = await seedCategory(h, rid, false);
    const hidden = await seedItem(h, rid, { categoryId: hiddenCat });
    const ghost = oid();
    const res = await quote({
      drop,
      items: [
        { restaurantId: rid, itemId: off, quantity: 1, selections: [] },
        { restaurantId: rid, itemId: ghost, quantity: 1, selections: [] },
        { restaurantId: rid, itemId: hidden, quantity: 1, selections: [] },
      ],
    });
    expect(res.status).toBe(200);
    const codes = res.body.problems.map((p: { code: string; itemId: string }) => `${p.code}:${p.itemId}`);
    expect(codes).toEqual(expect.arrayContaining([`ITEM_UNAVAILABLE:${off}`, `ITEM_UNAVAILABLE:${ghost}`, `ITEM_UNAVAILABLE:${hidden}`]));
    const lines = res.body.restaurants[0].lines;
    expect(lines.map((l: { itemId: string; available: boolean }) => [l.itemId, l.available])).toEqual([
      [off, false],
      [ghost, false],
      [hidden, false],
    ]);
  });

  it('item of another restaurant / unknown restaurant → ITEM_UNAVAILABLE', async () => {
    const other = await seedRestaurant(h.models, { location: loc });
    const ghostR = oid();
    const res = await quote({
      drop,
      items: [
        { restaurantId: other, itemId: naan, quantity: 1, selections: [] },
        { restaurantId: ghostR, itemId: naan, quantity: 1, selections: [] },
      ],
    });
    const p = res.body.problems.map((x: { code: string; restaurantId: string }) => `${x.code}:${x.restaurantId}`);
    expect(p).toEqual(expect.arrayContaining([`ITEM_UNAVAILABLE:${other}`, `ITEM_UNAVAILABLE:${ghostR}`]));
  });

  it.each([
    ['required group missing (min 1)', () => []],
    ['too many options in a group (max 1)', () => [{ groupId: size.id, optionIds: [size.regular, size.large] }]],
    ['unknown option', () => [{ groupId: size.id, optionIds: [oid()] }]],
    ['unknown group', () => [...large(), { groupId: oid(), optionIds: [oid()] }]],
    ['option from another group', () => [{ groupId: size.id, optionIds: [addons.cheese] }]],
    ['unavailable option', () => [...large(), { groupId: addons.id, optionIds: [addons.jalapeno] }]],
    ['duplicate option', () => [{ groupId: addons.id, optionIds: [addons.cheese, addons.cheese] }, ...large()]],
    ['group listed twice', () => [...large(), ...large()]],
  ])('INVALID_SELECTION: %s', async (_label, sel) => {
    const res = await quote({ drop, items: [{ restaurantId: rid, itemId: pizza, quantity: 1, selections: sel() }] });
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([expect.objectContaining({ code: 'INVALID_SELECTION', restaurantId: rid, itemId: pizza })]);
  });

  it('drop outside every service area → NOT_SERVICEABLE', async () => {
    const res = await quote({ drop: { lat: 13.3, lng: 77.6 }, items: [{ restaurantId: rid, itemId: naan, quantity: 1, selections: [] }] });
    expect(res.status).toBe(200);
    expect(res.body.restaurants[0]).toMatchObject({ serviceable: false, deliveryFeePaise: 0 });
    expect(res.body.problems).toEqual([expect.objectContaining({ code: 'NOT_SERVICEABLE', restaurantId: rid })]);
  });

  it('drop beyond the restaurant radius → NOT_SERVICEABLE', async () => {
    const far = northOf(loc, 8); // inside the area polygon, outside the 6 km radius
    const res = await quote({ drop: far, items: [{ restaurantId: rid, itemId: naan, quantity: 1, selections: [] }] });
    expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual(['NOT_SERVICEABLE']);
  });

  it('no drop (cart-add validation) → serviceability skipped, fee 0', async () => {
    const res = await quote({ items: [{ restaurantId: rid, itemId: naan, quantity: 1, selections: [] }] });
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    expect(res.body.restaurants[0]).toMatchObject({ serviceable: true, deliveryFeePaise: 0 });
  });

  it('tracked stock below the requested quantity (summed across lines) → OUT_OF_STOCK, stockOk false', async () => {
    const tracked = await seedItem(h, rid, { trackStock: true, stockQty: 3, reservedQty: 1 });
    const ok = await quote({ drop, items: [{ restaurantId: rid, itemId: tracked, quantity: 2, selections: [] }] });
    expect(ok.body.problems).toEqual([]);
    const res = await quote({
      drop,
      items: [
        { restaurantId: rid, itemId: tracked, quantity: 2, selections: [] },
        { restaurantId: rid, itemId: tracked, quantity: 1, selections: [] },
      ],
    });
    expect(res.body.restaurants[0].lines[0].stockOk).toBe(false);
    expect(res.body.problems.map((p: { code: string }) => p.code)).toContain('OUT_OF_STOCK');
  });

  it('multiple restaurants keep request order', async () => {
    const r2 = await seedRestaurant(h.models, { location: northOf(loc, 1) });
    const i2 = await seedItem(h, r2);
    const res = await quote({
      drop,
      items: [
        { restaurantId: r2, itemId: i2, quantity: 1, selections: [] },
        { restaurantId: rid, itemId: naan, quantity: 1, selections: [] },
      ],
    });
    expect(res.body.restaurants.map((r: { restaurantId: string }) => r.restaurantId)).toEqual([r2, rid]);
  });

  it('service token required; only orders may call', async () => {
    const body = { items: [{ restaurantId: rid, itemId: naan, quantity: 1, selections: [] }] };
    expect((await quote(body, await h.consumerToken())).status).toBe(401);
    expect((await quote(body, await h.internalToken('delivery'))).status).toBe(403);
    expect((await quote({ items: [] })).status).toBe(400);
  });
});
