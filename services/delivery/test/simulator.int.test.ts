import request from 'supertest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bearer, createJob, createPartner, setup, type Harness } from './helpers.js';

describe('demo location simulator', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('simulator', { SIMULATOR_STEP_MS: '20' });
  });
  afterAll(async () => h.cleanup());

  it('demo: emits 10 simulated pings along pickup→drop; never changes job state', async () => {
    const p = await createPartner(h, { location: at(0.1, 0) });
    const { job, payload } = await createJob(h, { dropAt: at(0, 3) });
    const admin = await h.adminToken();
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: p.id });

    const msgs: Record<string, unknown>[] = [];
    const sub = await subscribeRealtime(h.ctx.redis, [`user:${payload.userId}`], (_c, m) => {
      if (m.event === 'delivery.location') msgs.push(m.data as never);
    });
    try {
      const res = await request(h.app).post(`/api/v1/admin/delivery/demo/simulate/${job.id}`).set(bearer(admin));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ jobId: job.id, steps: 10, simulated: true });

      await waitFor(async () => (await h.ctx.models.LocationPing.countDocuments({ jobId: job._id })) === 10, { message: '10 pings' });
      const pings = await h.ctx.models.LocationPing.find({ jobId: job._id }).sort({ at: 1, _id: 1 }).lean();
      expect(pings.every((x) => x.simulated === true)).toBe(true);
      const last = pings.at(-1)!.location.coordinates;
      expect(last[1]).toBeCloseTo(at(0, 3).lat, 6);
      expect(last[0]).toBeCloseTo(at(0, 3).lng, 6);

      await waitFor(() => msgs.length === 10, { message: '10 realtime messages' });
      expect(msgs.every((m) => m.simulated === true && m.childOrderId === job.childOrderId)).toBe(true);

      const after = (await h.ctx.models.Job.findById(job.id).lean())!;
      expect(after.status).toBe('ASSIGNED');
      expect(after.locationSimulated).toBe(true);
      const tr = await request(h.app).get(`/api/v1/deliveries/tracking/${job.childOrderId}`).set(bearer(await h.token(payload.userId)));
      expect(tr.body.simulated).toBe(true);
      expect(await (await import('@thali/service-kit')).outboxModel(h.ctx.conn).countDocuments({ 'envelope.payload.action': 'delivery.demo_simulate' })).toBe(1);
    } finally {
      await sub.close();
    }
  });
});

describe('simulator outside demo mode', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('simulator_sandbox', { APP_MODE: 'sandbox' });
  });
  afterAll(async () => h.cleanup());

  it('sandbox → 404', async () => {
    const { job } = await createJob(h);
    const res = await request(h.app).post(`/api/v1/admin/delivery/demo/simulate/${job.id}`).set(bearer(await h.adminToken()));
    expect(res.status).toBe(404);
    expect(await h.ctx.models.LocationPing.countDocuments({})).toBe(0);
  });
});
