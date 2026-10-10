import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, outboxEvents, setup, type Harness } from './helpers.js';

describe('pickup / drop execution with handover codes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('execution');
  });
  afterAll(async () => h.cleanup());

  /** Partner + job + accepted offer. */
  async function assignedJob() {
    // only the new partner is online, so the offer surely goes to them
    await h.ctx.models.Partner.updateMany({}, { $set: { online: false } });
    const p = await createPartner(h, { location: at(0.1, 0) });
    const { job, payload } = await createJob(h);
    await runDispatchTick(h.ctx);
    const offer = await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: p._id });
    const token = await h.token(p.userId, ['CONSUMER', 'DELIVERY_PARTNER']);
    const acc = await request(h.app).post(`/api/v1/deliveries/offers/${offer!.id}/accept`).set(bearer(token));
    expect(acc.status).toBe(200);
    return { p, job, payload, token };
  }

  it('plain codes are never stored; only sha256 hashes', async () => {
    const { job, payload } = await createJob(h);
    const raw = JSON.stringify(await h.ctx.models.Job.findById(job.id).lean());
    expect(raw).not.toContain(`"${payload.pickupCode}"`);
    expect(raw).not.toContain(`"${payload.deliveryCode}"`);
    expect(job.pickupCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.deliveryCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('wrong pickup code ×5 → 423 lock (even the right code is refused afterwards)', async () => {
    const { job, token } = await assignedJob();
    expect((await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token))).body.status).toBe('AT_PICKUP');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '0000' });
      statuses.push(r.status);
      if (i < 4) {
        expect(r.body.error.code).toBe('DELIVERY_CODE_INVALID');
        expect(r.body.error.details.attemptsRemaining).toBe(4 - i);
      } else expect(r.body.error.code).toBe('DELIVERY_CODE_LOCKED');
    }
    expect(statuses).toEqual([400, 400, 400, 400, 423]);
    const right = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' });
    expect(right.status).toBe(423);
    expect((await h.ctx.models.Job.findById(job.id).lean())!.status).toBe('AT_PICKUP');
  });

  it('concurrent wrong guesses can never exceed 5 attempts', async () => {
    const { job, token } = await assignedJob();
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token));
    const codes = Array.from({ length: 12 }, (_, i) => String(9000 + i));
    const res = await Promise.all(codes.map((code) => request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code })));
    expect(res.filter((r) => r.status === 400)).toHaveLength(4);
    expect(res.filter((r) => r.status === 423)).toHaveLength(8);
    expect((await h.ctx.models.Job.findById(job.id).lean())!.codeAttempts).toBe(5);
  });

  it('happy path: arrived → pickup (right code) → start → deliver (customer code) releases capacity', async () => {
    const { p, job, token } = await assignedJob();
    // pickup before arriving is an invalid transition
    const early = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('DELIVERY_INVALID_TRANSITION');

    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token));
    const wrongOnce = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '9999' });
    expect(wrongOnce.status).toBe(400);
    const picked = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' });
    expect(picked.status).toBe(200);
    expect(picked.body.status).toBe('PICKED_UP');
    const pe = await outboxEvents(h, 'delivery.picked_up', { jobId: job.id });
    expect(pe).toHaveLength(1);
    expect(pe[0]!.envelope.payload).toMatchObject({ childOrderId: job.childOrderId, partnerUserId: p.userId });

    const active = await request(h.app).get('/api/v1/deliveries/active').set(bearer(token));
    expect(active.body.items.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect(active.body.items[0].drop.phoneMasked).toBe('+91•••••43210');
    expect(active.body.items[0].navigation.dropUrl).toContain('google.com/maps');

    const started = await request(h.app).post(`/api/v1/deliveries/${job.id}/start`).set(bearer(token));
    expect(started.body.status).toBe('OUT_FOR_DELIVERY');
    expect(await outboxEvents(h, 'delivery.started', { jobId: job.id })).toHaveLength(1);

    // pickup code does not work at the door (attempt counter was reset at pickup)
    const wrongDoor = await request(h.app).post(`/api/v1/deliveries/${job.id}/deliver`).set(bearer(token)).send({ code: '1234' });
    expect(wrongDoor.status).toBe(400);
    expect(wrongDoor.body.error.details.attemptsRemaining).toBe(4);
    const delivered = await request(h.app).post(`/api/v1/deliveries/${job.id}/deliver`).set(bearer(token)).send({ code: '5678' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.status).toBe('DELIVERED');
    const de = await outboxEvents(h, 'delivery.delivered', { jobId: job.id });
    expect(de).toHaveLength(1);
    expect(de[0]!.envelope.payload.distanceKm).toBe(job.distanceKm);

    expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
    const history = await request(h.app).get('/api/v1/deliveries/history').set(bearer(token));
    expect(history.body.items.map((j: { id: string }) => j.id)).toContain(job.id);
  });

  it('non-assigned partner actions → 404', async () => {
    const { job } = await assignedJob();
    const stranger = await createPartner(h, { location: at(5, 5) });
    const t = await h.token(stranger.userId);
    for (const path of ['arrived', 'start']) {
      expect((await request(h.app).post(`/api/v1/deliveries/${job.id}/${path}`).set(bearer(t))).status).toBe(404);
    }
    expect((await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(t)).send({ code: '1234' })).status).toBe(404);
    expect((await request(h.app).post(`/api/v1/deliveries/${job.id}/fail`).set(bearer(t)).send({ reason: 'Customer unreachable' })).status).toBe(404);
    // the attempt counter was not touched by the stranger
    expect((await h.ctx.models.Job.findById(job.id).lean())!.codeAttempts).toBe(0);
  });

  it('fail requires a reason; FAILED releases capacity and emits delivery.failed', async () => {
    const { p, job, token } = await assignedJob();
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token));
    await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' });
    const noReason = await request(h.app).post(`/api/v1/deliveries/${job.id}/fail`).set(bearer(token)).send({});
    expect(noReason.status).toBe(400);
    const failed = await request(h.app).post(`/api/v1/deliveries/${job.id}/fail`).set(bearer(token)).send({ reason: 'Customer unreachable at door' });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('FAILED');
    const ev = await outboxEvents(h, 'delivery.failed', { jobId: job.id });
    expect(ev[0]!.envelope.payload.reason).toBe('Customer unreachable at door');
    expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
  });
});
