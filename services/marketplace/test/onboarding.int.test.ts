import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, fullProfile, newId, settlementBody, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness('onboarding');
});
afterAll(async () => h?.close());

async function createDraft(token: string, body: Record<string, unknown> = { name: 'Spice Route' }) {
  const res = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.restaurant.id as string;
}

async function completeProfile(token: string, id: string, overrides: Record<string, unknown> = {}) {
  const p = await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send(fullProfile(overrides));
  expect(p.status).toBe(200);
  const s = await request(h.app).put(`/api/v1/owner/restaurants/${id}/settlement`).set(bearer(token)).send(settlementBody);
  expect(s.status).toBe(200);
}

describe('restaurant onboarding', () => {
  it('any signed-in user creates a DRAFT; RESTAURANT_OWNER is granted via identity; client must refresh', async () => {
    const userId = newId();
    const token = await h.consumerToken(userId);
    const res = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Dosa Corner' });
    expect(res.status).toBe(201);
    expect(res.body.roleGranted).toBe(true);
    expect(res.body.restaurant).toMatchObject({ name: 'Dosa Corner', status: 'DRAFT', ownerUserId: userId });
    expect(res.body.restaurant.slug).toMatch(/^dosa-corner/);
    expect(h.identity.calls).toContainEqual({ userId, role: 'RESTAURANT_OWNER' });
  });

  it('creation fails cleanly (no restaurant) when identity cannot grant the role', async () => {
    const userId = newId();
    h.identity.fail = true;
    try {
      const res = await request(h.app).post('/api/v1/owner/restaurants').set(bearer(await h.consumerToken(userId))).send({ name: 'X' });
      expect(res.status).toBe(502);
    } finally {
      h.identity.fail = false;
    }
    expect(await h.models.Restaurant.countDocuments({ ownerUserId: userId })).toBe(0);
  });

  it('unauthenticated create → 401', async () => {
    const res = await request(h.app).post('/api/v1/owner/restaurants').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('submit with missing fields → 422 listing the missing fields', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    const res = await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['businessName', 'description', 'cuisines', 'phone', 'businessEmail', 'address', 'location', 'hours', 'settlement']),
    );
    expect(res.body.error.details.missing).not.toContain('name');
    const r = await request(h.app).get(`/api/v1/owner/restaurants/${id}`).set(bearer(token));
    expect(r.body.status).toBe('DRAFT');
  });

  it('full submit → VERIFICATION_PENDING + restaurant.submitted + verification email event; cannot submit twice', async () => {
    const userId = newId();
    const token = await h.ownerToken(userId);
    const id = await createDraft(token);
    await completeProfile(token, id);

    const res = await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VERIFICATION_PENDING');
    expect(res.body.emailVerified).toBe(false);
    expect(res.body.phone).toBe('+919876543210');
    expect(res.body.settlement).toEqual({ accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '9012' });

    const submitted = (await h.events('restaurant.submitted')).filter((e) => e.aggregateId === id);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.payload).toEqual({ restaurantId: id, ownerUserId: userId });
    const verify = (await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id);
    expect(verify).toHaveLength(1);
    expect(verify[0]!.payload.email).toBe('owner@spiceroute.test');
    expect(verify[0]!.payload.verifyUrl).toMatch(/^http:\/\/api\.test\/api\/v1\/restaurants\/verify-email\?token=[A-Za-z0-9_-]{43}$/);

    // token is stored hashed only
    const doc = await h.models.Restaurant.findById(id).lean();
    const raw = new URL(String(verify[0]!.payload.verifyUrl)).searchParams.get('token')!;
    expect(JSON.stringify(doc)).not.toContain(raw);

    const again = await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RESTAURANT_INVALID_TRANSITION');
  });

  it('required documents (configurable) are listed as missing', async () => {
    const h2 = await createHarness('onboarding_docs', { REQUIRED_DOCUMENT_TYPES: 'FSSAI,GST' });
    try {
      const token = await h2.ownerToken();
      const c = await request(h2.app).post('/api/v1/owner/restaurants').set(bearer(token)).send({ name: 'Docs' });
      const id = c.body.restaurant.id;
      await request(h2.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send(fullProfile());
      await request(h2.app).put(`/api/v1/owner/restaurants/${id}/settlement`).set(bearer(token)).send(settlementBody);
      const res = await request(h2.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token));
      expect(res.status).toBe(422);
      expect(res.body.error.details.missing).toEqual(['documents.FSSAI', 'documents.GST']);
    } finally {
      await h2.close();
    }
  });

  it('owner B cannot read or patch owner A’s restaurant (404)', async () => {
    const a = await h.ownerToken();
    const b = await h.ownerToken();
    const id = await createDraft(a);
    expect((await request(h.app).get(`/api/v1/owner/restaurants/${id}`).set(bearer(b))).status).toBe(404);
    expect((await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(b)).send({ name: 'Hijack' })).status).toBe(404);
    expect((await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(b))).status).toBe(404);
    const list = await request(h.app).get('/api/v1/owner/restaurants').set(bearer(b));
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).not.toContain(id);
  });

  it('owner routes require the RESTAURANT_OWNER role (403 before token refresh)', async () => {
    const token = await h.consumerToken();
    expect((await request(h.app).get('/api/v1/owner/restaurants').set(bearer(token))).status).toBe(403);
  });

  it('admin approve from VERIFICATION_PENDING → 409 RESTAURANT_INVALID_TRANSITION (email gate)', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    await completeProfile(token, id);
    await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token)).expect(200);
    const res = await request(h.app)
      .post(`/api/v1/admin/marketplace/restaurants/${id}/approve`)
      .set(bearer(await h.adminToken()))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESTAURANT_INVALID_TRANSITION');
    expect((await h.models.Restaurant.findById(id).lean())!.status).toBe('VERIFICATION_PENDING');
  });

  it('changing businessEmail after verification resets verification and returns to VERIFICATION_PENDING', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    await completeProfile(token, id);
    await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token)).expect(200);
    const ev = (await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id);
    const verifyUrl = new URL(String(ev[0]!.payload.verifyUrl));
    await request(h.app).get(`${verifyUrl.pathname}${verifyUrl.search}`).expect(302);
    let r = await request(h.app).get(`/api/v1/owner/restaurants/${id}`).set(bearer(token));
    expect(r.body).toMatchObject({ status: 'APPROVAL_PENDING', emailVerified: true });

    // outside the 60 s verification-email cooldown
    await h.models.Restaurant.updateOne({ _id: id }, { $set: { 'emailVerificationLog.lastSentAt': new Date(Date.now() - 61_000) } });
    const p = await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send({ businessEmail: 'new@spiceroute.test' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: 'VERIFICATION_PENDING', emailVerified: false, businessEmail: 'new@spiceroute.test' });
    const ev2 = (await h.events('restaurant.email_verification_requested')).filter((e) => e.aggregateId === id);
    expect(ev2).toHaveLength(2);
    expect(ev2[1]!.payload.email).toBe('new@spiceroute.test');
    const changed = (await h.events('restaurant.status_changed')).filter((e) => e.aggregateId === id);
    expect(changed.map((e) => [e.payload.from, e.payload.to])).toEqual([
      ['DRAFT', 'VERIFICATION_PENDING'],
      ['VERIFICATION_PENDING', 'APPROVAL_PENDING'],
      ['APPROVAL_PENDING', 'VERIFICATION_PENDING'],
    ]);

    // the old token no longer verifies the new address
    await request(h.app).get(`${verifyUrl.pathname}${verifyUrl.search}`).expect(302);
    r = await request(h.app).get(`/api/v1/owner/restaurants/${id}`).set(bearer(token));
    expect(r.body.status).toBe('VERIFICATION_PENDING');
  });

  it('REJECTED restaurant resubmits → APPROVAL_PENDING (email still verified)', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    await completeProfile(token, id);
    await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token)).expect(200);
    await h.models.Restaurant.updateOne({ _id: id }, { $set: { status: 'REJECTED', statusReason: 'blurry FSSAI', emailVerifiedAt: new Date() } });
    const res = await request(h.app).post(`/api/v1/owner/restaurants/${id}/submit`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVAL_PENDING');
  });

  it('settlement validates account number and IFSC; responses expose last4 only; stored encrypted', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    const bad = await request(h.app)
      .put(`/api/v1/owner/restaurants/${id}/settlement`)
      .set(bearer(token))
      .send({ accountHolder: 'A', accountNumber: '12345678', ifsc: 'hdfc0001234' });
    expect(bad.status).toBe(400);
    const ok = await request(h.app).put(`/api/v1/owner/restaurants/${id}/settlement`).set(bearer(token)).send(settlementBody);
    expect(ok.body).toEqual({ accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '9012' });
    const doc = await h.models.Restaurant.findById(id).lean();
    expect(doc!.settlement!.accountNumberEnc).toMatch(/^v1:/);
    expect(JSON.stringify(doc)).not.toContain('123456789012');
    const audit = (await h.events('audit.recorded')).filter((e) => e.aggregateId === id);
    expect(audit.map((e) => e.payload.action)).toContain('restaurant.settlement_updated');
  });

  it('hours, pause and resume', async () => {
    const token = await h.ownerToken();
    const id = await createDraft(token);
    const hrs = await request(h.app)
      .put(`/api/v1/owner/restaurants/${id}/hours`)
      .set(bearer(token))
      .send({ hours: [{ day: 1, open: '18:00', close: '02:00' }] });
    expect(hrs.status).toBe(200);
    expect(hrs.body.hours).toEqual([{ day: 1, open: '18:00', close: '02:00' }]);
    const bad = await request(h.app).put(`/api/v1/owner/restaurants/${id}/hours`).set(bearer(token)).send({ hours: [{ day: 7, open: '25:00', close: '02:00' }] });
    expect(bad.status).toBe(400);

    const p = await request(h.app).post(`/api/v1/owner/restaurants/${id}/pause`).set(bearer(token)).send({ minutes: 30 });
    expect(p.status).toBe(200);
    const until = new Date(p.body.pausedUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 1000);
    const r = await request(h.app).post(`/api/v1/owner/restaurants/${id}/resume`).set(bearer(token));
    expect(r.body.pausedUntil).toBeNull();
  });

  it('PATCH emits restaurant.updated for the orders projection', async () => {
    const userId = newId();
    const token = await h.ownerToken(userId);
    const id = await createDraft(token);
    await request(h.app).patch(`/api/v1/owner/restaurants/${id}`).set(bearer(token)).send(fullProfile({ name: 'Renamed' })).expect(200);
    const upd = (await h.events('restaurant.updated')).filter((e) => e.aggregateId === id);
    expect(upd.at(-1)!.payload).toEqual({
      restaurantId: id,
      ownerUserId: userId,
      name: 'Renamed',
      status: 'DRAFT',
      location: { type: 'Point', coordinates: [77.6412, 12.9716] },
    });
  });

  it('GET /internal/restaurants/:id returns the binding shape (service token only)', async () => {
    const userId = newId();
    const token = await h.ownerToken(userId);
    const id = await createDraft(token);
    await completeProfile(token, id, { address: { line1: '12 100 Feet Road', line2: 'HAL 2nd Stage', city: 'Bengaluru', pincode: '560038' } });
    const res = await request(h.app).get(`/internal/restaurants/${id}`).set(bearer(await h.internalToken('payments')));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      ownerUserId: userId,
      name: 'Spice Route',
      status: 'DRAFT',
      location: { lat: 12.9716, lng: 77.6412 },
      address: { line1: '12 100 Feet Road', line2: 'HAL 2nd Stage', city: 'Bengaluru', pincode: '560038' },
      phone: '+919876543210',
      commissionBps: 1800,
      packagingFeePaise: 0,
      avgPrepMinutes: 20,
      pureVeg: false, // no menu yet, not declared
      images: { coverUrl: null, logoUrl: null },
    });
    expect((await request(h.app).get(`/internal/restaurants/${id}`).set(bearer(token))).status).toBe(401);
    expect((await request(h.app).get(`/internal/restaurants/${newId()}`).set(bearer(await h.internalToken('orders')))).status).toBe(404);
    expect((await request(h.app).get(`/internal/restaurants/${id}`).set(bearer(await h.internalToken('identity')))).status).toBe(403);
  });
});
