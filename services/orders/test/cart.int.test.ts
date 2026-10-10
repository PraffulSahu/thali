import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('cart');
});
afterAll(async () => {
  await h.cleanup();
});

const sel = (groupId: string, ...optionIds: string[]) => ({ groupId, optionIds });

describe('cart lines (Review Focus #5: same item, different customizations)', () => {
  it('same item with different selections → 2 lines; identical selections → quantity merged', async () => {
    const s = h.marketplace.seedTwo();
    const u = await asUser(h);
    const [regular, large] = s.size.options;
    const [cheese, mint] = s.extras.options;

    const a = await u.post('/api/v1/cart/items', {
      restaurantId: s.a.id,
      itemId: s.paneer.id,
      quantity: 1,
      selections: [sel(s.size.id, regular!.id), sel(s.extras.id, cheese!.id, mint!.id)],
    });
    expect(a.status).toBe(201);
    const b = await u.post('/api/v1/cart/items', {
      restaurantId: s.a.id,
      itemId: s.paneer.id,
      quantity: 1,
      selections: [sel(s.size.id, large!.id)],
    });
    expect(b.status).toBe(201);
    expect(b.body.lineId).not.toBe(a.body.lineId);

    // identical selections in a different order (groups and option ids) → same line, quantity merged
    const c = await u.post('/api/v1/cart/items', {
      restaurantId: s.a.id,
      itemId: s.paneer.id,
      quantity: 2,
      selections: [sel(s.extras.id, mint!.id, cheese!.id), sel(s.size.id, regular!.id)],
    });
    expect(c.status).toBe(201);
    expect(c.body.lineId).toBe(a.body.lineId);

    const cart = await u.get('/api/v1/cart');
    expect(cart.status).toBe(200);
    const lines = cart.body.groups[0].lines;
    expect(lines).toHaveLength(2);
    const merged = lines.find((l: { lineId: string }) => l.lineId === a.body.lineId);
    expect(merged.quantity).toBe(3);
    // price snapshot from the marketplace quote: (25000 + 0 + 2000 + 1000) × 3
    expect(merged.unitPricePaise).toBe(25000);
    expect(merged.addOns.map((x: { name: string }) => x.name).sort()).toEqual(['Cheese', 'Mint chutney', 'Regular']);
    expect(merged.lineTotalPaise).toBe(84000);
  });

  it('quantity > 20 → 400 (single add, and merged total)', async () => {
    const s = h.marketplace.seedTwo();
    const u = await asUser(h);
    const r = await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 21 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');

    expect((await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 15 })).status).toBe(201);
    const over = await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 6 });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('VALIDATION_FAILED');

    const lineId = (await u.get('/api/v1/cart')).body.groups[0].lines[0].lineId;
    expect((await u.patch(`/api/v1/cart/items/${lineId}`, { quantity: 21 })).status).toBe(400);
  });

  it('invalid selections → 422 INVALID_SELECTION from the quote (min/max, unknown, unavailable option)', async () => {
    const s = h.marketplace.seedTwo();
    const u = await asUser(h);
    const base = { restaurantId: s.a.id, itemId: s.paneer.id, quantity: 1 };

    const missingRequired = await u.post('/api/v1/cart/items', { ...base, selections: [] });
    expect(missingRequired.status).toBe(422);
    expect(missingRequired.body.error.code).toBe('INVALID_SELECTION');
    expect(missingRequired.body.error.details.problems[0]).toMatchObject({ code: 'INVALID_SELECTION', itemId: s.paneer.id });

    const tooMany = await u.post('/api/v1/cart/items', {
      ...base,
      selections: [sel(s.size.id, s.size.options[0]!.id, s.size.options[1]!.id)],
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('INVALID_SELECTION');

    const unavailableOption = await u.post('/api/v1/cart/items', {
      ...base,
      selections: [sel(s.size.id, s.size.options[0]!.id), sel(s.extras.id, s.extras.options[2]!.id)],
    });
    expect(unavailableOption.status).toBe(422);
    expect(unavailableOption.body.error.code).toBe('INVALID_SELECTION');

    const unknownOption = await u.post('/api/v1/cart/items', {
      ...base,
      selections: [sel(s.size.id, s.dosa.id)],
    });
    expect(unknownOption.status).toBe(422);

    // nothing was stored
    const cart = await u.get('/api/v1/cart');
    expect(cart.body.groups).toEqual([]);
  });

  it('unavailable item → 422 ITEM_UNAVAILABLE', async () => {
    const s = h.marketplace.seedTwo();
    s.dosa.available = false;
    const u = await asUser(h);
    const r = await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ITEM_UNAVAILABLE');
  });

  it('items from 2 restaurants are grouped in GET /cart with per-restaurant subtotals', async () => {
    const s = h.marketplace.seedTwo();
    const u = await asUser(h);
    await u.post('/api/v1/cart/items', { restaurantId: s.a.id, itemId: s.dal.id, quantity: 2 });
    await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 3 });
    await u.post('/api/v1/cart/items', {
      restaurantId: s.a.id,
      itemId: s.paneer.id,
      quantity: 1,
      selections: [sel(s.size.id, s.size.options[1]!.id)],
    });
    const cart = await u.get('/api/v1/cart');
    expect(cart.status).toBe(200);
    expect(cart.body.groups).toHaveLength(2);
    const ga = cart.body.groups.find((g: { restaurantId: string }) => g.restaurantId === s.a.id);
    const gb = cart.body.groups.find((g: { restaurantId: string }) => g.restaurantId === s.b.id);
    expect(ga.restaurantName).toBe('Spice Route');
    expect(ga.lines).toHaveLength(2);
    expect(ga.subtotalPaise).toBe(2 * 25000 + 28000);
    expect(gb.subtotalPaise).toBe(3 * 15000);
    expect(gb.delivery.note).toBe('Delivered separately by restaurant');
    expect(cart.body.subtotalPaise).toBe(ga.subtotalPaise + gb.subtotalPaise);
    expect(cart.body.itemCount).toBe(6);
    expect(cart.body.cartVersion).toBe(3);
  });

  it('PATCH / DELETE line and DELETE cart bump cartVersion', async () => {
    const s = h.marketplace.seedTwo();
    const u = await asUser(h);
    const add = await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 1 });
    const lineId = add.body.lineId;
    const p = await u.patch(`/api/v1/cart/items/${lineId}`, { quantity: 4, note: 'extra crispy' });
    expect(p.status).toBe(200);
    expect(p.body.groups[0].lines[0]).toMatchObject({ quantity: 4, note: 'extra crispy', lineTotalPaise: 60000 });
    expect(p.body.cartVersion).toBe(2);
    const d = await u.del(`/api/v1/cart/items/${lineId}`);
    expect(d.status).toBe(200);
    expect(d.body.groups).toEqual([]);
    expect(d.body.cartVersion).toBe(3);
    await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 1 });
    const clear = await u.del('/api/v1/cart');
    expect(clear.status).toBe(200);
    expect(clear.body.groups).toEqual([]);
  });

  it('user A cannot modify user B cart line (404)', async () => {
    const s = h.marketplace.seedTwo();
    const a = await asUser(h);
    const b = await asUser(h);
    const add = await b.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 1 });
    const lineId = add.body.lineId;
    await a.post('/api/v1/cart/items', { restaurantId: s.a.id, itemId: s.dal.id, quantity: 1 });

    const p = await a.patch(`/api/v1/cart/items/${lineId}`, { quantity: 5 });
    expect(p.status).toBe(404);
    expect(p.body.error.code).toBe('NOT_FOUND');
    expect((await a.del(`/api/v1/cart/items/${lineId}`)).status).toBe(404);
    expect((await b.get('/api/v1/cart')).body.groups[0].lines[0].quantity).toBe(1);
  });

  it('guest cart: issue token, add with X-Guest-Cart, unknown token 404, no credentials 401', async () => {
    const s = h.marketplace.seedTwo();
    const g = await request(h.app).post('/api/v1/cart/guest');
    expect(g.status).toBe(201);
    expect(g.body.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = g.body.guestToken as string;

    const add = await request(h.app)
      .post('/api/v1/cart/items')
      .set('X-Guest-Cart', token)
      .send({ restaurantId: s.b.id, itemId: s.dosa.id, quantity: 2 });
    expect(add.status).toBe(201);
    const cart = await request(h.app).get('/api/v1/cart').set('X-Guest-Cart', token);
    expect(cart.status).toBe(200);
    expect(cart.body.ownerType).toBe('GUEST');
    expect(cart.body.itemCount).toBe(2);

    // token is stored hashed, never raw
    const raw = await h.db.conn.collection('carts').findOne({ ownerType: 'GUEST', guestTokenHash: { $exists: true } });
    expect(JSON.stringify(raw)).not.toContain(token);

    expect((await request(h.app).get('/api/v1/cart').set('X-Guest-Cart', 'A'.repeat(43))).status).toBe(404);
    expect((await request(h.app).get('/api/v1/cart')).status).toBe(401);
  });

  it('address and coupon are stored on the cart', async () => {
    const u = await asUser(h);
    const a = await u.put('/api/v1/cart/address', {
      addressId: 'addr1',
      address: { line1: '1 Main', city: 'Bengaluru', pincode: '560001', location: { lat: 12.9, lng: 77.6 } },
    });
    expect(a.status).toBe(200);
    expect(a.body.deliveryAddress).toMatchObject({ addressId: 'addr1', line1: '1 Main', location: { lat: 12.9, lng: 77.6 } });
    const c = await u.put('/api/v1/cart/coupon', { couponCode: 'welcome50' });
    expect(c.status).toBe(200);
    expect(c.body.couponCode).toBe('WELCOME50');
    const c2 = await u.put('/api/v1/cart/coupon', { couponCode: null });
    expect(c2.body.couponCode).toBeNull();
  });
});
