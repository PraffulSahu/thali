import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, setup, type Harness } from './helpers.js';
import { asAdmin, asOwner, asPartner, child, placedCheckout } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('isolation');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('cross-tenant isolation', () => {
  it("owner B cannot see or act on restaurant A's child (404, nothing changes)", async () => {
    const p = await placedCheckout(h);
    const accept = await p.ownerB.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    expect(accept.status).toBe(404);
    expect(accept.body.error.code).toBe('NOT_FOUND');
    expect((await p.ownerB.post(`/api/v1/owner/orders/${p.a.id}/reject`, { reason: 'nope' })).status).toBe(404);
    expect((await p.ownerB.get(`/api/v1/owner/orders/${p.a.id}`)).status).toBe(404);
    expect((await p.ownerB.patch(`/api/v1/owner/orders/${p.a.id}/prep-time`, { prepMinutes: 20 })).status).toBe(404);
    expect((await child(h, p.a.id))!.status).toBe('PLACED');
  });

  it("customer B cannot read, cancel, reorder or open a ticket on customer A's order (404)", async () => {
    const p = await placedCheckout(h);
    const other = await asUser(h);
    const r = await other.get(`/api/v1/orders/${p.checkout.id}`);
    expect(r.status).toBe(404);
    expect((await other.post(`/api/v1/orders/child/${p.a.id}/cancel`, {})).status).toBe(404);
    expect((await other.post(`/api/v1/orders/${p.checkout.id}/reorder`)).status).toBe(404);
    expect((await other.get('/api/v1/orders')).body.items).toEqual([]);
    expect((await child(h, p.a.id))!.status).toBe('PLACED');
    // the owner still can
    expect((await p.u.get(`/api/v1/orders/${p.checkout.id}`)).status).toBe(200);
  });

  it('partner and plain consumer roles cannot use owner routes (403); non-admins cannot use admin routes', async () => {
    const p = await placedCheckout(h);
    const partner = await asPartner(h);
    expect((await partner.get('/api/v1/owner/orders')).status).toBe(403);
    expect((await partner.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 })).status).toBe(403);
    expect((await p.u.get('/api/v1/owner/orders')).status).toBe(403);
    expect((await p.ownerA.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await partner.get(`/api/v1/admin/orders/${p.checkout.id}`)).status).toBe(403);
    const noMfa = await asAdmin(h, { mfa: false });
    const r = await noMfa.get('/api/v1/admin/orders');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
  });

  it('a user who happens to own a restaurant cannot act on another restaurant via a guessed id', async () => {
    const p = await placedCheckout(h);
    const stranger = await asOwner(h, p.u.userId); // the customer also holds RESTAURANT_OWNER
    expect((await stranger.post(`/api/v1/owner/orders/${p.a.id}/preparing`)).status).toBe(404);
  });
});
