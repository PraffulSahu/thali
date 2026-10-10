/** DLV-3 live remaining ETA on tracking + `remainingMinutes` on delivery.location (30 s cache). */
import request from 'supertest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORIGIN, at, bearer, createJob, createPartner, deliverEvent, envelope, setup, type Harness } from './helpers.js';

describe('DLV-3 remaining ETA', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('eta');
  });
  afterAll(async () => h.cleanup());

  async function assigned() {
    const p = await createPartner(h, { location: at(1, 0) });
    const { job, payload } = await createJob(h, { dropAt: at(0, 4) });
    const r = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(await h.adminToken())).send({ partnerId: p.id });
    expect(r.status).toBe(200);
    return { p, job, payload, partnerToken: await h.token(p.userId), customerToken: await h.token(payload.userId) };
  }
  const track = (childOrderId: string, token: string) => request(h.app).get(`/api/v1/deliveries/tracking/${childOrderId}`).set(bearer(token));
  const leg = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => h.ctx.geo.distanceAndEta(a, b);

  it('null before a partner is assigned', async () => {
    const { job, payload } = await createJob(h);
    const res = await track(job.childOrderId, await h.token(payload.userId));
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBeNull();
  });

  it('ASSIGNED: rider → pickup + wait for food + pickup → drop; cached 30 s; recomputed after pickup', async () => {
    const { job, payload, partnerToken, customerToken } = await assigned();
    // food is ready → no wait
    await deliverEvent(h, envelope('order.ready', { childOrderId: job.childOrderId, restaurantId: payload.restaurantId, userId: payload.userId }, job.childOrderId));
    const toPickup = await leg(at(1, 0), ORIGIN);
    const toDrop = await leg(ORIGIN, at(0, 4));
    const res = await track(job.childOrderId, customerToken);
    expect(res.body.remaining).toMatchObject({
      minutes: Math.ceil(toPickup.etaMinutes + toDrop.etaMinutes),
      distanceKm: Math.round((toPickup.distanceKm + toDrop.distanceKm) * 10) / 10,
      source: 'DEMO_HAVERSINE',
    });

    // within 30 s: served from the cache (no geo calls)
    const spy = vi.spyOn(h.ctx.geo, 'distanceAndEta');
    h.clock.advance(10_000);
    const cached = await track(job.childOrderId, customerToken);
    expect(cached.body.remaining).toEqual(res.body.remaining);
    expect(spy).not.toHaveBeenCalled();

    // after 30 s: recomputed
    h.clock.advance(25_000);
    await track(job.childOrderId, customerToken);
    expect(spy).toHaveBeenCalled();
    spy.mockClear();

    // a status change invalidates immediately; after pickup only rider → drop remains
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(partnerToken)).expect(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(partnerToken)).send({ code: '1234' }).expect(200);
    const picked = await track(job.childOrderId, customerToken);
    expect(spy).toHaveBeenCalledTimes(1);
    const fromRider = await leg(at(1, 0), at(0, 4));
    expect(picked.body.remaining.minutes).toBe(Math.max(1, Math.ceil(fromRider.etaMinutes)));
    spy.mockRestore();
  });

  it('admin reassign (same status) does not serve the previous rider\'s cached ETA', async () => {
    const { job, payload, customerToken } = await assigned();
    await deliverEvent(h, envelope('order.ready', { childOrderId: job.childOrderId, restaurantId: payload.restaurantId, userId: payload.userId }, job.childOrderId));
    const first = await track(job.childOrderId, customerToken);
    const other = await createPartner(h, { location: at(3, 0) });
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(await h.adminToken())).send({ partnerId: other.id }).expect(200);
    await h.ctx.models.Job.updateOne({ _id: job._id }, { $unset: { lastLocation: 1 } }); // new rider has not pinged on this job yet
    const second = await track(job.childOrderId, customerToken);
    const expected = Math.ceil((await leg(at(3, 0), ORIGIN)).etaMinutes + (await leg(ORIGIN, at(0, 4))).etaMinutes);
    expect(second.body.remaining.minutes).toBe(expected);
    expect(second.body.remaining.minutes).not.toBe(first.body.remaining.minutes);
  });

  it('pre-pickup ETA includes the remaining prep time until readyEta', async () => {
    const { job, customerToken } = await assigned();
    const prepLeft = (new Date((await h.ctx.models.Job.findById(job.id).lean())!.readyEta!).getTime() - h.clock.now().getTime()) / 60_000;
    const legs = (await leg(at(1, 0), ORIGIN)).etaMinutes + (await leg(ORIGIN, at(0, 4))).etaMinutes;
    const res = await track(job.childOrderId, customerToken);
    expect(res.body.remaining.minutes).toBe(Math.ceil(legs + Math.max(0, prepLeft)));
  });

  it('delivery.location carries remainingMinutes', async () => {
    const { job, payload, partnerToken } = await assigned();
    const msgs: Record<string, unknown>[] = [];
    const sub = await subscribeRealtime(h.ctx.redis, [`user:${payload.userId}`], (_c, m) => {
      if (m.event === 'delivery.location') msgs.push(m.data as never);
    });
    try {
      await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(partnerToken)).expect(200);
      await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(partnerToken)).send({ code: '1234' }).expect(200);
      const here = at(0, 2);
      expect((await request(h.app).post('/api/v1/partner/location').set(bearer(partnerToken)).send(here)).status).toBe(200);
      await waitFor(() => msgs.length === 1, { message: 'delivery.location' });
      expect(msgs[0]).toMatchObject({ childOrderId: job.childOrderId, remainingMinutes: Math.max(1, Math.ceil((await leg(here, at(0, 4))).etaMinutes)) });
    } finally {
      await sub.close();
    }
  });

  it('geo failure degrades to remaining: null (tracking still 200)', async () => {
    const { job, customerToken } = await assigned();
    const spy = vi.spyOn(h.ctx.geo, 'distanceAndEta').mockRejectedValue(new Error('routes down'));
    const res = await track(job.childOrderId, customerToken);
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBeNull();
    spy.mockRestore();
  });
});
