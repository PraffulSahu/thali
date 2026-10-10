import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, setup, type Harness } from './helpers.js';
import { placedCheckout } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('reorder');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('reorder', () => {
  it('re-adds everything unchanged when nothing changed', async () => {
    const p = await placedCheckout(h);
    expect((await p.u.get('/api/v1/cart')).body.itemCount).toBe(0); // cleared on placement
    const r = await p.u.post(`/api/v1/orders/${p.checkout.id}/reorder`);
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual([]);
    expect(r.body.addedCount).toBe(2);
    expect(r.body.cart.itemCount).toBe(3);
    expect(r.body.cart.restaurantCount).toBe(2);
    // the customization (Large + Cheese) is preserved
    const paneerLine = r.body.cart.groups.find((g: { restaurantId: string }) => g.restaurantId === p.s.a.id).lines[0];
    expect(paneerLine.addOns.map((a: { name: string }) => a.name).sort()).toEqual(['Cheese', 'Large']);
  });

  it('adds available items and reports price change / unavailable item / closed restaurant', async () => {
    const p = await placedCheckout(h);
    p.s.paneer.pricePaise = 26_000; // was 25 000 (+3 000 Large +2 000 Cheese per unit)
    const r1 = await p.u.post(`/api/v1/orders/${p.checkout.id}/reorder`);
    expect(r1.status).toBe(200);
    expect(r1.body.changes).toEqual([
      expect.objectContaining({
        kind: 'PRICE_CHANGED',
        restaurantId: p.s.a.id,
        itemId: p.s.paneer.id,
        name: 'Paneer Tikka',
        oldUnitPricePaise: 30_000,
        newUnitPricePaise: 31_000,
        added: true,
      }),
    ]);
    expect(r1.body.cart.itemCount).toBe(3);

    // second customer order: dosa unavailable, then restaurant A closed
    const p2 = await placedCheckout(h);
    p2.s.dosa.available = false;
    p2.s.a.open = false;
    const r2 = await p2.u.post(`/api/v1/orders/${p2.checkout.id}/reorder`);
    expect(r2.status).toBe(200);
    expect(r2.body.addedCount).toBe(0);
    expect(r2.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ITEM_UNAVAILABLE', restaurantId: p2.s.b.id, itemId: p2.s.dosa.id, added: false }),
        expect.objectContaining({ kind: 'RESTAURANT_CLOSED', restaurantId: p2.s.a.id, itemId: p2.s.paneer.id, added: false }),
      ]),
    );
    expect(r2.body.changes).toHaveLength(2);
    expect(r2.body.cart.itemCount).toBe(0);
    expect(r2.body.changes.every((c: { message: string }) => typeof c.message === 'string' && c.message.length > 0)).toBe(true);
  });

  it("another user's checkout → 404", async () => {
    const p = await placedCheckout(h);
    const other = await asUser(h);
    expect((await other.post(`/api/v1/orders/${p.checkout.id}/reorder`)).status).toBe(404);
  });
});
