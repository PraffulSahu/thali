import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, createHarness, newId, type Harness } from './helpers.js';

let h: Harness;
let token: string;
let rid: string;
beforeAll(async () => {
  h = await createHarness('menu');
  token = await h.ownerToken();
  const c = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Menu House' });
  rid = c.body.restaurant.id;
});
afterAll(async () => h?.close());

const url = (p = '') => `/api/v1/owner/restaurants/${rid}${p}`;

const groups = [
  {
    name: 'Size',
    minSelect: 1,
    maxSelect: 1,
    options: [
      { name: 'Regular', pricePaise: 0, isVeg: true },
      { name: 'Large', pricePaise: 5000, isVeg: true },
    ],
  },
  {
    name: 'Add-ons',
    minSelect: 0,
    maxSelect: 2,
    options: [
      { name: 'Extra cheese', pricePaise: 3000, isVeg: true },
      { name: 'Olives', pricePaise: 2000, isVeg: true },
      { name: 'Jalapeños', pricePaise: 2000, isVeg: true, available: false },
    ],
  },
];

describe('menu categories and items', () => {
  let catId: string;
  let itemId: string;

  it('category CRUD', async () => {
    const c = await request(h.app).post(url('/categories')).set(bearer(token)).send({ name: 'Pizzas', sortOrder: 2 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Pizzas', sortOrder: 2, active: true, restaurantId: rid });
    catId = c.body.id;
    await request(h.app).post(url('/categories')).set(bearer(token)).send({ name: 'Starters', sortOrder: 1 }).expect(201);
    const list = await request(h.app).get(url('/categories')).set(bearer(token));
    expect(list.body.items.map((x: { name: string }) => x.name)).toEqual(['Starters', 'Pizzas']);
    const p = await request(h.app).patch(url(`/categories/${catId}`)).set(bearer(token)).send({ name: 'Wood-fired Pizzas' });
    expect(p.body.name).toBe('Wood-fired Pizzas');
    expect((await request(h.app).post(url('/categories')).set(bearer(token)).send({ name: '' })).status).toBe(400);
  });

  it('item create with customization groups (server-assigned stable ids)', async () => {
    const res = await request(h.app)
      .post(url('/items'))
      .set(bearer(token))
      .send({ categoryId: catId, name: 'Margherita', description: 'Classic', pricePaise: 29900, isVeg: true, customizationGroups: groups, tags: ['bestseller'] });
    expect(res.status).toBe(201);
    itemId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Margherita', pricePaise: 29900, isVeg: true, available: true, trackStock: false, tags: ['bestseller'] });
    expect(res.body.customizationGroups).toHaveLength(2);
    const g = res.body.customizationGroups[1];
    expect(g.id).toMatch(/^[a-f0-9]{24}$/);
    expect(g.options[2]).toMatchObject({ name: 'Jalapeños', available: false });
    expect(g.options[0].available).toBe(true);

    // PATCH keeping ids keeps them stable (carts reference groupId/optionIds)
    const patched = await request(h.app)
      .patch(url(`/items/${itemId}`))
      .set(bearer(token))
      .send({ pricePaise: 31900, customizationGroups: res.body.customizationGroups.map((x: { id: string }) => x) });
    expect(patched.status).toBe(200);
    expect(patched.body.pricePaise).toBe(31900);
    expect(patched.body.customizationGroups[1].id).toBe(g.id);
    expect(patched.body.customizationGroups[1].options[0].id).toBe(g.options[0].id);
  });

  it('customization validation: minSelect ≤ maxSelect ≤ options.length', async () => {
    const bad = async (group: Record<string, unknown>) =>
      request(h.app)
        .post(url('/items'))
        .set(bearer(token))
        .send({ categoryId: catId, name: 'Bad', pricePaise: 100, isVeg: true, customizationGroups: [group] });
    const opts = [{ name: 'A', pricePaise: 0, isVeg: true }];
    expect((await bad({ name: 'G', minSelect: 2, maxSelect: 1, options: [...opts, ...opts] })).status).toBe(400);
    expect((await bad({ name: 'G', minSelect: 0, maxSelect: 2, options: opts })).status).toBe(400);
    expect((await bad({ name: 'G', minSelect: 0, maxSelect: 1, options: [] })).status).toBe(400);
    expect((await bad({ name: 'G', minSelect: -1, maxSelect: 1, options: opts })).status).toBe(400);
    const r = await bad({ name: 'G', minSelect: 1, maxSelect: 1, options: opts });
    expect(r.status).toBe(201);
  });

  it('item validation: category must belong to this restaurant; price is integer paise', async () => {
    const other = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: newId(), name: 'X', pricePaise: 100, isVeg: true });
    expect(other.status).toBe(404);
    const float = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: catId, name: 'X', pricePaise: 10.5, isVeg: true });
    expect(float.status).toBe(400);
  });

  it('availability toggle and stock set', async () => {
    const off = await request(h.app).patch(url(`/items/${itemId}/availability`)).set(bearer(token)).send({ available: false });
    expect(off.status).toBe(200);
    expect(off.body.available).toBe(false);
    const stock = await request(h.app).patch(url(`/items/${itemId}/availability`)).set(bearer(token)).send({ available: true, stockQty: 12 });
    expect(stock.body).toMatchObject({ available: true, trackStock: true, stockQty: 12, reservedQty: 0 });
    expect((await request(h.app).patch(url(`/items/${itemId}/availability`)).set(bearer(token)).send({ stockQty: -1 })).status).toBe(400);
    expect((await request(h.app).patch(url(`/items/${itemId}/availability`)).set(bearer(token)).send({})).status).toBe(400);

    // cannot set stock below what is currently reserved by pending checkouts
    await h.models.MenuItem.updateOne({ _id: itemId }, { $set: { reservedQty: 5 } });
    const below = await request(h.app).patch(url(`/items/${itemId}/availability`)).set(bearer(token)).send({ stockQty: 3 });
    expect(below.status).toBe(409);
    await h.models.MenuItem.updateOne({ _id: itemId }, { $set: { reservedQty: 0 } });
  });

  it('stock floor is enforced at write time: a reservation landing after the read still blocks PATCH stockQty (409)', async () => {
    await h.models.MenuItem.updateOne({ _id: itemId }, { $set: { stockQty: 10, reservedQty: 0, trackStock: true } });
    // Simulate a concurrent reservation committing right after updateItem reads the item.
    const model = h.models.MenuItem;
    const orig = model.findOne.bind(model);
    let bumped = false;
    const spy = vi.spyOn(model, 'findOne').mockImplementation(((...args: Parameters<typeof orig>) => {
      const q = orig(...args);
      const exec = q.exec.bind(q);
      q.exec = (async (...a: unknown[]) => {
        const r = await (exec as (...x: unknown[]) => Promise<unknown>)(...a);
        if (!bumped) {
          bumped = true;
          await model.collection.updateOne({ _id: new Types.ObjectId(itemId) }, { $set: { reservedQty: 5 } });
        }
        return r;
      }) as typeof q.exec;
      return q;
    }) as unknown as typeof model.findOne);
    try {
      const res = await request(h.app).patch(url(`/items/${itemId}`)).set(bearer(token)).send({ stockQty: 3, name: 'Margherita v2' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    } finally {
      spy.mockRestore();
    }
    expect(bumped).toBe(true);
    const doc = await h.models.MenuItem.findById(itemId).lean();
    expect(doc).toMatchObject({ stockQty: 10, reservedQty: 5, name: 'Margherita' }); // nothing applied
    const ok = await request(h.app).patch(url(`/items/${itemId}`)).set(bearer(token)).send({ stockQty: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ stockQty: 5, reservedQty: 5, availableQty: 0 });
    await h.models.MenuItem.updateOne({ _id: itemId }, { $set: { reservedQty: 0 } });
  });

  it('list, get, delete items; a category with items cannot be deleted', async () => {
    const list = await request(h.app).get(url('/items')).set(bearer(token));
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(itemId);
    const byCat = await request(h.app).get(url('/items')).query({ categoryId: catId }).set(bearer(token));
    expect(byCat.body.items.every((x: { categoryId: string }) => x.categoryId === catId)).toBe(true);
    expect((await request(h.app).get(url(`/items/${itemId}`)).set(bearer(token))).status).toBe(200);

    const delCat = await request(h.app).delete(url(`/categories/${catId}`)).set(bearer(token));
    expect(delCat.status).toBe(409);
    for (const i of byCat.body.items) await request(h.app).delete(url(`/items/${i.id}`)).set(bearer(token)).expect(204);
    expect((await request(h.app).get(url(`/items/${itemId}`)).set(bearer(token))).status).toBe(404);
    await request(h.app).delete(url(`/categories/${catId}`)).set(bearer(token)).expect(204);
  });

  it('owner isolation on menu routes (404 for another owner)', async () => {
    const b = await h.ownerToken();
    const cat = await request(h.app).post(url('/categories')).set(bearer(token)).send({ name: 'Mine' });
    const item = await request(h.app).post(url('/items')).set(bearer(token)).send({ categoryId: cat.body.id, name: 'Mine', pricePaise: 100, isVeg: true });
    expect((await request(h.app).get(url('/categories')).set(bearer(b))).status).toBe(404);
    expect((await request(h.app).post(url('/categories')).set(bearer(b)).send({ name: 'x' })).status).toBe(404);
    expect((await request(h.app).patch(url(`/items/${item.body.id}`)).set(bearer(b)).send({ name: 'x' })).status).toBe(404);
    expect((await request(h.app).patch(url(`/items/${item.body.id}/availability`)).set(bearer(b)).send({ available: false })).status).toBe(404);
    expect((await request(h.app).delete(url(`/items/${item.body.id}`)).set(bearer(b))).status).toBe(404);
    expect((await h.models.MenuItem.findById(item.body.id).lean())!.name).toBe('Mine');
  });
});
