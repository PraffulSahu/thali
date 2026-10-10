import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, newId, seedRestaurant, seedServiceArea, type Harness } from './helpers.js';

let h: Harness;
const drop = { lat: 12.975, lng: 77.62 };
beforeAll(async () => {
  h = await createHarness('admin_approval');
  await seedServiceArea(h.models);
});
afterAll(async () => h?.close());

const base = '/api/v1/admin/marketplace/restaurants';
const pending = () => seedRestaurant(h.models, { status: 'APPROVAL_PENDING', location: { lat: 12.97, lng: 77.62 } });

describe('admin approval', () => {
  it('approve → APPROVED + restaurant.status_changed + audit event', async () => {
    const id = await pending();
    const adminId = newId();
    const res = await request(h.app).post(`${base}/${id}/approve`).set(bearer(await h.adminToken({ userId: adminId }))).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.statusHistory.at(-1)).toMatchObject({ from: 'APPROVAL_PENDING', to: 'APPROVED', actorId: adminId });

    const changed = (await h.events('restaurant.status_changed')).filter((e) => e.aggregateId === id);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      restaurantId: id,
      from: 'APPROVAL_PENDING',
      to: 'APPROVED',
      location: { type: 'Point', coordinates: [77.62, 12.97] },
    });
    const audit = (await h.events('audit.recorded')).filter((e) => e.aggregateId === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'restaurant.approve',
      targetType: 'restaurant',
      targetId: id,
      service: 'marketplace',
    });
  });

  it('approving twice → 409', async () => {
    const id = await pending();
    const t = await h.adminToken();
    await request(h.app).post(`${base}/${id}/approve`).set(bearer(t)).send({}).expect(200);
    const again = await request(h.app).post(`${base}/${id}/approve`).set(bearer(t)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RESTAURANT_INVALID_TRANSITION');
  });

  it('reject requires a reason; with reason → REJECTED + statusReason', async () => {
    const id = await pending();
    const t = await h.adminToken();
    const noReason = await request(h.app).post(`${base}/${id}/reject`).set(bearer(t)).send({});
    expect(noReason.status).toBe(400);
    const blank = await request(h.app).post(`${base}/${id}/reject`).set(bearer(t)).send({ reason: '   ' });
    expect(blank.status).toBe(400);
    const res = await request(h.app).post(`${base}/${id}/reject`).set(bearer(t)).send({ reason: 'FSSAI licence unreadable' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', statusReason: 'FSSAI licence unreadable' });
    const changed = (await h.events('restaurant.status_changed')).filter((e) => e.aggregateId === id);
    expect(changed[0]!.payload.reason).toBe('FSSAI licence unreadable');
  });

  it('suspend (reason required) removes the restaurant from discovery; reinstate restores it', async () => {
    const id = await seedRestaurant(h.models, { status: 'APPROVED', location: { lat: 12.97, lng: 77.62 } });
    const t = await h.adminToken();
    const ids = async () => {
      const d = await request(h.app).get('/api/v1/discovery/restaurants').query(drop);
      expect(d.status).toBe(200);
      return d.body.items.map((i: { id: string }) => i.id);
    };
    expect(await ids()).toContain(id);
    expect((await request(h.app).post(`${base}/${id}/suspend`).set(bearer(t)).send({})).status).toBe(400);
    const s = await request(h.app).post(`${base}/${id}/suspend`).set(bearer(t)).send({ reason: 'hygiene complaint' });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('SUSPENDED');
    expect(await ids()).not.toContain(id);
    expect((await request(h.app).get(`/api/v1/restaurants/${id}`)).status).toBe(404);

    const r = await request(h.app).post(`${base}/${id}/reinstate`).set(bearer(t)).send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('APPROVED');
    expect(await ids()).toContain(id);
    const actions = (await h.events('audit.recorded')).filter((e) => e.aggregateId === id).map((e) => e.payload.action);
    expect(actions).toEqual(['restaurant.suspend', 'restaurant.reinstate']);
  });

  it('non-admin → 403; admin without MFA → 403 MFA_REQUIRED; anonymous → 401', async () => {
    const id = await pending();
    const owner = await request(h.app).post(`${base}/${id}/approve`).set(bearer(await h.ownerToken())).send({});
    expect(owner.status).toBe(403);
    const noMfa = await request(h.app).post(`${base}/${id}/approve`).set(bearer(await h.adminToken({ mfa: false }))).send({});
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe('MFA_REQUIRED');
    expect((await request(h.app).get(base)).status).toBe(401);
    expect((await h.models.Restaurant.findById(id).lean())!.status).toBe('APPROVAL_PENDING');
  });

  it('admin list filters by status and paginates; detail includes documents and statusHistory', async () => {
    const t = await h.adminToken();
    const a = await pending();
    const b = await pending();
    const res = await request(h.app).get(base).query({ status: 'APPROVAL_PENDING', limit: 1 }).set(bearer(t));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toEqual(expect.any(String));
    const page2 = await request(h.app).get(base).query({ status: 'APPROVAL_PENDING', limit: 100, cursor: res.body.nextCursor }).set(bearer(t));
    const all = [res.body.items[0].id, ...page2.body.items.map((i: { id: string }) => i.id)];
    expect(all).toEqual(expect.arrayContaining([a, b]));
    expect(new Set(all).size).toBe(all.length);
    for (const i of [...res.body.items, ...page2.body.items]) expect(i.status).toBe('APPROVAL_PENDING');

    const d = await request(h.app).get(`${base}/${a}`).set(bearer(t));
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id: a, documents: [], statusHistory: [] });
  });

  it('admin catalog CRUD (cuisines, banners, service areas) is admin+MFA and audited', async () => {
    const t = await h.adminToken();
    const c = await request(h.app).post('/api/v1/admin/marketplace/cuisines').set(bearer(t)).send({ name: 'South Indian', sortOrder: 2 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'South Indian', slug: 'south-indian', active: true, sortOrder: 2 });
    const dup = await request(h.app).post('/api/v1/admin/marketplace/cuisines').set(bearer(t)).send({ name: 'South Indian' });
    expect(dup.status).toBe(409);
    const pub = await request(h.app).get('/api/v1/cuisines');
    expect(pub.body.items.map((x: { slug: string }) => x.slug)).toContain('south-indian');
    await request(h.app).patch(`/api/v1/admin/marketplace/cuisines/${c.body.id}`).set(bearer(t)).send({ active: false }).expect(200);
    expect((await request(h.app).get('/api/v1/cuisines')).body.items.map((x: { slug: string }) => x.slug)).not.toContain('south-indian');

    const b = await request(h.app)
      .post('/api/v1/admin/marketplace/banners')
      .set(bearer(t))
      .send({ title: 'Diwali offers', imageKey: 'catalog/banners/diwali.png', linkType: 'CUISINE', linkValue: 'sweets', activeFrom: new Date(Date.now() - 1000).toISOString(), activeTo: new Date(Date.now() + 86400_000).toISOString() });
    expect(b.status).toBe(201);
    const banners = await request(h.app).get('/api/v1/banners');
    expect(banners.body.items).toEqual([expect.objectContaining({ id: b.body.id, title: 'Diwali offers', imageUrl: 'http://localhost:9000/thali-public/catalog/banners/diwali.png', isDemo: false })]);
    await request(h.app).delete(`/api/v1/admin/marketplace/banners/${b.body.id}`).set(bearer(t)).expect(204);
    expect((await request(h.app).get('/api/v1/banners')).body.items).toEqual([]);

    const badArea = await request(h.app)
      .post('/api/v1/admin/marketplace/service-areas')
      .set(bearer(t))
      .send({ name: 'Bad', polygon: { type: 'Polygon', coordinates: [[[77, 12], [78, 12]]] }, deliveryFee: { basePaise: 1, baseKm: 1, perKmPaise: 1, maxPaise: 1 }, minOrderPaise: 0 });
    expect(badArea.status).toBe(400);
    const area = await request(h.app)
      .post('/api/v1/admin/marketplace/service-areas')
      .set(bearer(t))
      .send({ name: 'Mysuru', polygon: { type: 'Polygon', coordinates: [[[76.6, 12.25], [76.7, 12.25], [76.7, 12.35], [76.6, 12.35]]] }, deliveryFee: { basePaise: 1500, baseKm: 2, perKmPaise: 400, maxPaise: 6000 }, minOrderPaise: 9900 });
    expect(area.status).toBe(201);
    const sv = await request(h.app).get('/api/v1/discovery/serviceability').query({ lat: 12.3, lng: 76.65 });
    expect(sv.body).toEqual({ serviceable: true, area: { id: area.body.id, name: 'Mysuru', minOrderPaise: 9900 } });

    const noMfa = await request(h.app).post('/api/v1/admin/marketplace/cuisines').set(bearer(await h.adminToken({ mfa: false }))).send({ name: 'Nope' });
    expect(noMfa.status).toBe(403);
    const actions = (await h.events('audit.recorded')).map((e) => e.payload.action);
    expect(actions).toEqual(expect.arrayContaining(['cuisine.create', 'cuisine.update', 'banner.create', 'banner.delete', 'service_area.create']));
  });
});
