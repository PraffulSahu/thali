import request from 'supertest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, outboxEvents, setup, type Harness } from './helpers.js';

describe('dispatch (LLD 7)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('dispatch');
  });
  afterAll(async () => h.cleanup());
  beforeEach(async () => {
    await h.ctx.models.Partner.deleteMany({});
    await h.ctx.models.Offer.deleteMany({});
    await h.ctx.models.Job.deleteMany({});
  });

  it('offers the nearest 3 eligible online partners within 3 km; stale/offline/unapproved/far excluded; partner.offer realtime', async () => {
    const near1 = await createPartner(h, { location: at(0.5, 0) });
    const near2 = await createPartner(h, { location: at(0, 1.2) });
    const near3 = await createPartner(h, { location: at(-1.8, 0) });
    const fourth = await createPartner(h, { location: at(2.6, 0) });
    await createPartner(h, { location: at(0.1, 0), lastLocationAt: new Date(h.clock.now().getTime() - 5 * 60_000) }); // stale
    await createPartner(h, { location: at(0.1, 0.1), online: false });
    await createPartner(h, { location: at(0.2, 0.1), status: 'SUSPENDED', online: true });
    await createPartner(h, { location: at(4, 0) }); // outside round-1 radius

    const received: { channel: string; data: { offerId: string; jobId: string; expiresAt: string } }[] = [];
    const sub = await subscribeRealtime(h.ctx.redis, ['partner:*'], (channel, m) => {
      if (m.event === 'partner.offer') received.push({ channel, data: m.data as never });
    });
    try {
      const { job } = await createJob(h);
      expect(job.status).toBe('PENDING_ASSIGNMENT');
      expect(job.estimateSource).toBe('DEMO_HAVERSINE');
      expect(job.distanceKm).toBeGreaterThan(3);
      expect((await outboxEvents(h, 'delivery.job_created', { jobId: job.id })).length).toBe(1);

      await runDispatchTick(h.ctx);
      const offers = await h.ctx.models.Offer.find({ jobId: job._id }).lean();
      expect(offers.map((o) => o.partnerId.toString()).sort()).toEqual([near1.id, near2.id, near3.id].sort());
      expect(offers.every((o) => o.status === 'OFFERED' && o.round === 1)).toBe(true);
      expect(offers.every((o) => o.expiresAt.getTime() === h.clock.now().getTime() + 45_000)).toBe(true);
      expect(offers[0]!.batchEvaluation.eligible).toBe(true);
      expect(offers.map((o) => o.partnerId.toString())).not.toContain(fourth.id);

      const fresh = await h.ctx.models.Job.findById(job.id).lean();
      expect(fresh).toMatchObject({ status: 'OFFERED', dispatchRound: 1 });

      await waitFor(() => received.length === 3, { message: 'partner.offer realtime x3' });
      expect(received.map((r) => r.channel).sort()).toEqual([near1, near2, near3].map((p) => `partner:${p.userId}`).sort());

      // the partner sees the offer with explainable batching reasons
      const mine = await request(h.app).get('/api/v1/partner/offers').set(bearer(await h.token(near1.userId)));
      expect(mine.status).toBe(200);
      expect(mine.body.items).toHaveLength(1);
      expect(mine.body.items[0]).toMatchObject({ jobId: job.id, batchEvaluation: { eligible: true } });
      expect(mine.body.items[0].batchEvaluation.reasons.length).toBeGreaterThan(0);

      // a second tick within the TTL does not re-offer
      await runDispatchTick(h.ctx);
      expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id })).toBe(3);
    } finally {
      await sub.close();
    }
  });

  it('offers expire after TTL → round 2 widens the radius to 5 km', async () => {
    const near = await createPartner(h, { location: at(1, 0) });
    const far = await createPartner(h, { location: at(4, 0) });
    const { job } = await createJob(h);

    await runDispatchTick(h.ctx);
    expect((await h.ctx.models.Offer.find({ jobId: job._id }).lean()).map((o) => o.partnerId.toString())).toEqual([near.id]);

    h.clock.advance(46_000);
    await h.ctx.models.Partner.updateMany({}, { $set: { lastLocationAt: h.clock.now() } });
    await runDispatchTick(h.ctx);

    const r1 = await h.ctx.models.Offer.findOne({ jobId: job._id, round: 1 }).lean();
    expect(r1!.status).toBe('EXPIRED');
    const r2 = await h.ctx.models.Offer.find({ jobId: job._id, round: 2 }).lean();
    expect(r2.map((o) => o.partnerId.toString()).sort()).toEqual([near.id, far.id].sort());
    expect((await h.ctx.models.Job.findById(job.id).lean())!.dispatchRound).toBe(2);
  });

  it('a partner who rejected is not re-offered; rejecting the last live offer triggers the next round immediately', async () => {
    const p = await createPartner(h, { location: at(0.3, 0) });
    const other = await createPartner(h, { location: at(3.5, 0) });
    const { job } = await createJob(h);
    await runDispatchTick(h.ctx);
    const offer = await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: p._id });
    const rej = await request(h.app).post(`/api/v1/deliveries/offers/${offer!.id}/reject`).set(bearer(await h.token(p.userId)));
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('REJECTED');

    await runDispatchTick(h.ctx); // no clock advance needed
    const r2 = await h.ctx.models.Offer.find({ jobId: job._id, round: 2 }).lean();
    expect(r2.map((o) => o.partnerId.toString())).toEqual([other.id]);
  });

  it('idle partners rank before batch candidates', async () => {
    const busy = await createPartner(h, { location: at(0.1, 0) });
    const { job: first } = await createJob(h, { dropAt: at(0, 3) });
    await h.ctx.models.Job.updateOne({ _id: first._id }, { $set: { status: 'ASSIGNED', partnerId: busy._id, partnerUserId: busy.userId } });
    await h.ctx.models.Partner.updateOne({ _id: busy._id }, { $push: { activeJobIds: first._id } });
    const idle = [await createPartner(h, { location: at(1, 0) }), await createPartner(h, { location: at(1.2, 0) }), await createPartner(h, { location: at(1.4, 0) })];

    const { job } = await createJob(h, { pickupAt: at(0, 0.3), dropAt: at(0.5, 3) });
    await runDispatchTick(h.ctx);
    const offers = await h.ctx.models.Offer.find({ jobId: job._id }).lean();
    expect(offers.map((o) => o.partnerId.toString()).sort()).toEqual(idle.map((p) => p.id).sort());
  });

  it('batch candidate gets an offer with ✓ reasons when there are fewer idle partners', async () => {
    const busy = await createPartner(h, { location: at(0.1, 0) });
    const { job: first } = await createJob(h, { dropAt: at(0, 3) });
    await h.ctx.models.Job.updateOne({ _id: first._id }, { $set: { status: 'ASSIGNED', partnerId: busy._id, partnerUserId: busy.userId } });
    await h.ctx.models.Partner.updateOne({ _id: busy._id }, { $push: { activeJobIds: first._id } });
    const { job } = await createJob(h, { pickupAt: at(0, 0.3), dropAt: at(0.5, 3) });
    await runDispatchTick(h.ctx);
    const offer = await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: busy._id }).lean();
    expect(offer).not.toBeNull();
    expect(offer!.batchEvaluation.eligible).toBe(true);
    expect(offer!.batchEvaluation.reasons.some((r) => r.startsWith('pickup ') && r.endsWith('✓'))).toBe(true);
  });

  it('after 5 rounds without acceptance → exception flag + delivery.exception (status unchanged)', async () => {
    const { job } = await createJob(h);
    for (let i = 0; i < 5; i++) {
      await runDispatchTick(h.ctx);
      h.clock.advance(46_000);
    }
    expect((await h.ctx.models.Job.findById(job.id).lean())!.dispatchRound).toBe(5);
    expect(await outboxEvents(h, 'delivery.exception', { jobId: job.id })).toHaveLength(0);
    await runDispatchTick(h.ctx);
    const after = await h.ctx.models.Job.findById(job.id).lean();
    expect(after).toMatchObject({ status: 'PENDING_ASSIGNMENT', exception: true, dispatchRound: 5 });
    expect(await outboxEvents(h, 'delivery.exception', { jobId: job.id })).toHaveLength(1);
    // further ticks do not emit again
    h.clock.advance(46_000);
    await runDispatchTick(h.ctx);
    expect(await outboxEvents(h, 'delivery.exception', { jobId: job.id })).toHaveLength(1);
  });
});
