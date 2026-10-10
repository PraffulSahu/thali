/** DLV-1 partner "Call": DEMO / DIRECT modes, allowed states, ownership, audit, rate limit. */
import request from 'supertest';
import { outboxModel, UpstreamError } from '@thali/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { displayMasked } from '../src/domain/contact.js';
import { at, bearer, createJob, createPartner, setup, type Harness } from './helpers.js';

async function assigned(h: Harness, overrides: Parameters<typeof createJob>[1] = {}) {
  const p = await createPartner(h, { location: at(0.1, 0) });
  const { job, payload } = await createJob(h, overrides);
  const r = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(await h.adminToken())).send({ partnerId: p.id });
  expect(r.status).toBe(200);
  return { p, job, payload, token: await h.token(p.userId, ['CONSUMER', 'DELIVERY_PARTNER']) };
}

const contact = (h: Harness, jobId: string, token: string, target: string) =>
  request(h.app).post(`/api/v1/deliveries/${jobId}/contact`).set(bearer(token)).send({ target });

const audits = (h: Harness, jobId: string) =>
  outboxModel(h.ctx.conn).find({ 'envelope.type': 'audit.recorded', 'envelope.payload.action': 'delivery.contact_revealed', 'envelope.payload.targetId': jobId }).lean();

describe('displayMasked', () => {
  it('keeps only the country code and last 4 digits', () => {
    expect(displayMasked('+919876543210')).toBe('+91 ••••• •3210');
    expect(displayMasked('+91******3210')).toBe('+91 ••••• •3210');
    expect(displayMasked('+918041234567')).toBe('+91 ••••• •4567');
    expect(displayMasked('+14155550123')).toBe('+1 ••••• •0123');
    expect(displayMasked('')).toBeNull();
  });
});

describe('DLV-1 contact — DEMO mode (APP_MODE=demo)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('contact_demo');
  });
  afterAll(async () => h.cleanup());

  it('restaurant while ASSIGNED: simulated, masked, audited; customer full number never fetched', async () => {
    const { job, token, p } = await assigned(h, { pickup: { name: 'Meghana Foods', address: '12 Residency Rd', location: { type: 'Point', coordinates: [77.5946, 12.9716] }, phone: '+918041234567' } });
    const getUser = vi.spyOn(h.ctx.identity, 'getUser');
    const res = await contact(h, job.id, token, 'RESTAURANT');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ target: 'RESTAURANT', mode: 'DEMO', telUrl: null, displayNumber: '+91 ••••• •4567', note: 'Calling is simulated in demo' });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(h.clock.now().getTime());
    expect(h.marketplace.state.calls).toBe(0); // pickup.phone came on order.accepted

    const rows = await audits(h, job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope.payload).toMatchObject({ actorId: p.userId, actorRole: 'DELIVERY_PARTNER', targetType: 'delivery_job', service: 'delivery' });
    expect(JSON.stringify(rows[0]!.envelope.payload)).not.toContain('8041234567');

    // customer is not callable before arriving at the restaurant
    const early = await contact(h, job.id, token, 'CUSTOMER');
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('NOT_CALLABLE_NOW');

    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    const cust = await contact(h, job.id, token, 'CUSTOMER');
    expect(cust.status).toBe(200);
    expect(cust.body).toMatchObject({ mode: 'DEMO', telUrl: null, displayNumber: '+91 ••••• •3210' });
    expect(getUser).not.toHaveBeenCalled();
    expect(await audits(h, job.id)).toHaveLength(2);
    getUser.mockRestore();
  });

  it('restaurant is not callable after pickup; nothing is callable once delivered', async () => {
    const { job, token } = await assigned(h);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' }).expect(200);
    expect((await contact(h, job.id, token, 'RESTAURANT')).status).toBe(409);
    expect((await contact(h, job.id, token, 'CUSTOMER')).status).toBe(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/start`).set(bearer(token)).expect(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/deliver`).set(bearer(token)).send({ code: '5678' }).expect(200);
    const after = await contact(h, job.id, token, 'CUSTOMER');
    expect(after.status).toBe(409);
    expect(after.body.error.details.reason).toBe('NOT_CALLABLE_NOW');
  });

  it('other partners, unassigned jobs, missing role and bad targets are refused (404 / 403 / 400) and not audited', async () => {
    const { job, p } = await assigned(h);
    const stranger = await createPartner(h, { location: at(0.2, 0) });
    const strangerToken = await h.token(stranger.userId, ['CONSUMER', 'DELIVERY_PARTNER']);
    const res = await contact(h, job.id, strangerToken, 'RESTAURANT');
    expect(res.status).toBe(404);
    const { job: open } = await createJob(h);
    expect((await contact(h, open.id, strangerToken, 'RESTAURANT')).status).toBe(404);
    expect((await contact(h, job.id, strangerToken, 'ADMIN')).status).toBe(400);
    // the assigned partner without the DELIVERY_PARTNER role (e.g. revoked) is refused
    const noRole = await contact(h, job.id, await h.token(p.userId, ['CONSUMER']), 'RESTAURANT');
    expect(noRole.status).toBe(403);
    expect((await request(h.app).post(`/api/v1/deliveries/${job.id}/contact`).send({ target: 'CUSTOMER' })).status).toBe(401);
    expect(await audits(h, job.id)).toHaveLength(0);
  });

  it('falls back to marketplace for the restaurant phone; rate limited at 10/min/partner', async () => {
    const { job, payload, token } = await assigned(h);
    h.marketplace.restaurants.set(payload.restaurantId, { id: payload.restaurantId, name: 'Meghana Foods', phone: '+918022223333' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await contact(h, job.id, token, 'RESTAURANT')).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await audits(h, job.id)).toHaveLength(10);
  });
});

describe('DLV-1 contact — DIRECT mode (pilot)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('contact_direct', { APP_MODE: 'sandbox' });
  });
  afterAll(async () => h.cleanup());

  it('customer: tel: URL from identity; restaurant: marketplace fallback; masked displayNumber', async () => {
    const { job, payload, token } = await assigned(h);
    h.identity.addUser({ id: payload.userId, phone: '+919812345670', name: 'Asha' });
    h.marketplace.restaurants.set(payload.restaurantId, { id: payload.restaurantId, name: 'Meghana Foods', phone: '+918022223333' });

    const rest = await contact(h, job.id, token, 'RESTAURANT');
    expect(rest.status).toBe(200);
    expect(rest.body).toMatchObject({ mode: 'DIRECT', telUrl: 'tel:+918022223333', displayNumber: '+91 ••••• •3333', note: null });

    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    const cust = await contact(h, job.id, token, 'CUSTOMER');
    expect(cust.status).toBe(200);
    expect(cust.body).toMatchObject({ mode: 'DIRECT', telUrl: 'tel:+919812345670', displayNumber: '+91 ••••• •5670' });
    const rows = await audits(h, job.id);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(JSON.stringify(r.envelope.payload)).not.toMatch(/9812345670|8022223333/);
  });

  it('no phone on file → 409 NO_PHONE_ON_FILE; marketplace down → 502, nothing audited', async () => {
    const { job, token } = await assigned(h);
    h.marketplace.state.fail = new UpstreamError('marketplace', 0, 'UPSTREAM_UNAVAILABLE', 'marketplace unavailable', 502);
    const down = await contact(h, job.id, token, 'RESTAURANT');
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    h.marketplace.state.fail = null;

    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    const none = await contact(h, job.id, token, 'CUSTOMER'); // identity has no such user
    expect(none.status).toBe(409);
    expect(none.body.error.details.reason).toBe('NO_PHONE_ON_FILE');
    expect(await audits(h, job.id)).toHaveLength(0);
  });
});
