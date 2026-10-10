import request from 'supertest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bearer, createJob, createPartner, oid, setup, type Harness } from './helpers.js';

describe('live tracking', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('tracking');
  });
  afterAll(async () => h.cleanup());

  async function assigned() {
    const p = await createPartner(h, { location: at(0.1, 0), name: 'Mohammed Irfan' });
    const { job, payload } = await createJob(h);
    const admin = await h.adminToken();
    const r = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: p.id });
    expect(r.status).toBe(200);
    return { p, job, payload, partnerToken: await h.token(p.userId), customerToken: await h.token(payload.userId) };
  }

  it('before assignment: owner sees status with no partner/location; other users get 404', async () => {
    const { job, payload } = await createJob(h);
    const res = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(await h.token(payload.userId)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PENDING_ASSIGNMENT', partner: null, location: null, lastLocationAt: null, stale: false, simulated: false });

    const other = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(await h.token(oid())));
    expect(other.status).toBe(404);
    const anon = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`);
    expect(anon.status).toBe(401);
  });

  it('partner ping updates the job, publishes delivery.location to the customer, is rate limited, and goes stale after 60 s', async () => {
    const { p, job, payload, partnerToken, customerToken } = await assigned();
    const msgs: { channel: string; data: Record<string, unknown> }[] = [];
    const sub = await subscribeRealtime(h.ctx.redis, ['user:*'], (channel, m) => {
      if (m.event === 'delivery.location') msgs.push({ channel, data: m.data as never });
    });
    try {
      const loc = at(0.05, 0.02);
      const ping = await request(h.app).post('/api/v1/partner/location').set(bearer(partnerToken)).send({ ...loc, accuracyM: 12 });
      expect(ping.status).toBe(200);
      expect(ping.body.jobsUpdated).toBe(1);

      await waitFor(() => msgs.length === 1, { message: 'delivery.location' });
      expect(msgs[0]!.channel).toBe(`user:${payload.userId}`);
      expect(msgs[0]!.data).toMatchObject({ childOrderId: job.childOrderId, lat: loc.lat, lng: loc.lng, simulated: false });

      // 1 ping / 3 s per partner
      const tooSoon = await request(h.app).post('/api/v1/partner/location').set(bearer(partnerToken)).send(loc);
      expect(tooSoon.status).toBe(429);
      expect(tooSoon.headers['retry-after']).toBeDefined();

      const tr = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(customerToken));
      expect(tr.status).toBe(200);
      expect(tr.body).toMatchObject({
        status: 'ASSIGNED',
        partner: { firstName: 'Mohammed', vehicleType: 'BIKE' },
        location: { lat: loc.lat, lng: loc.lng },
        stale: false,
        simulated: false,
      });
      expect(tr.body.partner.phone).toBeUndefined();
      expect(new Date(tr.body.lastLocationAt).getTime()).toBe(h.clock.now().getTime());

      // ping persisted (ephemeral realtime, but the ping row is stored with TTL)
      expect(await h.ctx.models.LocationPing.countDocuments({ partnerId: p._id, jobId: job._id, simulated: false })).toBe(1);
      // location pings are NOT stream events
      const { outboxModel } = await import('@thali/service-kit');
      expect(await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': /location/ })).toBe(0);

      h.clock.advance(61_000);
      const stale = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(customerToken));
      expect(stale.body.stale).toBe(true);
    } finally {
      await sub.close();
    }
  });

  it('ping from a non-assigned partner is ignored for that job', async () => {
    const { job, customerToken } = await assigned();
    const before = (await h.ctx.models.Job.findById(job.id).lean())!;
    const intruder = await createPartner(h, { location: at(1, 1) });
    const t = await h.token(intruder.userId);

    const general = await request(h.app).post('/api/v1/partner/location').set(bearer(t)).send(at(2, 2));
    expect(general.status).toBe(200);
    expect(general.body.jobsUpdated).toBe(0);

    // (a second intruder: the 1-per-3-s limiter is keyed per partner on real Redis time)
    const intruder2 = await createPartner(h, { location: at(1, 1) });
    const scoped = await request(h.app).post(`/api/v1/deliveries/${job.id}/location`).set(bearer(await h.token(intruder2.userId))).send(at(2, 2));
    expect(scoped.status).toBe(404);

    const after = (await h.ctx.models.Job.findById(job.id).lean())!;
    expect(after.lastLocation ?? null).toEqual(before.lastLocation ?? null);
    const tr = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(customerToken));
    expect(tr.body.location).toBeNull();
    // intruder's own location did update (general ping)
    expect((await h.ctx.models.Partner.findById(intruder._id).lean())!.lastLocation!.coordinates[1]).toBeCloseTo(at(2, 2).lat, 6);
  });

  it('job-scoped ping by the assigned partner updates the job', async () => {
    const { job, partnerToken, customerToken } = await assigned();
    const loc = at(0.3, 0.3);
    const r = await request(h.app).post(`/api/v1/deliveries/${job.id}/location`).set(bearer(partnerToken)).send(loc);
    expect(r.status).toBe(200);
    expect(r.body.jobsUpdated).toBe(1);
    const tr = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(customerToken));
    expect(tr.body.location).toEqual({ lat: loc.lat, lng: loc.lng });
  });
});
