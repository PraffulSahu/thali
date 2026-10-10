/**
 * Race-safety of assignment (LLD 7 atomic accept). Real concurrency: Promise.all of HTTP requests
 * against a listening server, real Mongo replica-set transactions.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, outboxEvents, setup, type Harness } from './helpers.js';

describe('atomic accept under real concurrency', () => {
  let h: Harness;
  let server: Server;
  beforeAll(async () => {
    h = await setup('accept_race', { OFFERS_PER_ROUND: '5' });
    server = h.app.listen(0);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await h.cleanup();
  });
  beforeEach(async () => {
    await h.ctx.models.Partner.deleteMany({});
    await h.ctx.models.Offer.deleteMany({});
    await h.ctx.models.Job.deleteMany({});
  });

  for (let iteration = 1; iteration <= 5; iteration++) {
    it(`5 partners accept the same job concurrently → exactly one wins (iteration ${iteration})`, async () => {
      const partners = await Promise.all([0.2, 0.4, 0.6, 0.8, 1.0].map((km) => createPartner(h, { location: at(km, 0) })));
      const { job } = await createJob(h);
      await runDispatchTick(h.ctx);
      const offers = await h.ctx.models.Offer.find({ jobId: job._id, status: 'OFFERED' }).lean();
      expect(offers).toHaveLength(5);

      const tokens = await Promise.all(partners.map((p) => h.token(p.userId, ['CONSUMER', 'DELIVERY_PARTNER'])));
      const results = await Promise.all(
        offers.map((o) => {
          const idx = partners.findIndex((p) => p.id === o.partnerId.toString());
          return request(server).post(`/api/v1/deliveries/offers/${o._id.toString()}/accept`).set(bearer(tokens[idx]!));
        }),
      );

      const ok = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflicts).toHaveLength(4);
      for (const c of conflicts) expect(['ASSIGNMENT_TAKEN', 'OFFER_EXPIRED']).toContain(c.body.error.code);

      const winnerOffer = offers.find((o) => o._id.toString() === ok[0]!.body.offerId)!;
      const after = await h.ctx.models.Job.findById(job.id).lean();
      expect(after!.status).toBe('ASSIGNED');
      expect(after!.partnerId!.toString()).toBe(winnerOffer.partnerId.toString());
      expect(after!.statusHistory.filter((s) => s.to === 'ASSIGNED')).toHaveLength(1);

      const finalOffers = await h.ctx.models.Offer.find({ jobId: job._id }).lean();
      expect(finalOffers.filter((o) => o.status === 'ACCEPTED')).toHaveLength(1);
      expect(finalOffers.filter((o) => o.status === 'CANCELLED')).toHaveLength(4);

      const holding = await h.ctx.models.Partner.find({ activeJobIds: job._id }).lean();
      expect(holding.map((p) => p._id.toString())).toEqual([winnerOffer.partnerId.toString()]);

      const assigned = await outboxEvents(h, 'delivery.assigned', { jobId: job.id });
      expect(assigned).toHaveLength(1);
      expect(assigned[0]!.envelope.payload).toMatchObject({ partnerId: winnerOffer.partnerId.toString(), vehicle: { type: 'BIKE' } });
    });
  }

  it('one partner (maxActive=1) accepting two different jobs concurrently → one 409 CAPACITY_EXCEEDED', async () => {
    const p = await createPartner(h, { location: at(0.2, 0), maxActive: 1 });
    const { job: j1 } = await createJob(h);
    const { job: j2 } = await createJob(h, { pickupAt: at(0, 0.2), dropAt: at(0.3, 3) });
    await runDispatchTick(h.ctx);
    const o1 = await h.ctx.models.Offer.findOne({ jobId: j1._id, partnerId: p._id }).lean();
    const o2 = await h.ctx.models.Offer.findOne({ jobId: j2._id, partnerId: p._id }).lean();
    expect(o1 && o2).toBeTruthy();

    const token = await h.token(p.userId);
    const results = await Promise.all([o1!, o2!].map((o) => request(server).post(`/api/v1/deliveries/offers/${o._id.toString()}/accept`).set(bearer(token))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('CAPACITY_EXCEEDED');

    const partner = await h.ctx.models.Partner.findById(p._id).lean();
    expect(partner!.activeJobIds).toHaveLength(1);
    const jobs = await h.ctx.models.Job.find({ _id: { $in: [j1._id, j2._id] } }).lean();
    expect(jobs.filter((j) => j.status === 'ASSIGNED')).toHaveLength(1);
    const unassigned = jobs.find((j) => j.status !== 'ASSIGNED')!;
    expect(unassigned.partnerId ?? null).toBeNull();
    // the losing transaction rolled back completely: its offer is still live
    const loserOffer = await h.ctx.models.Offer.findOne({ jobId: unassigned._id, partnerId: p._id }).lean();
    expect(loserOffer!.status).toBe('OFFERED');
    expect(await outboxEvents(h, 'delivery.assigned', { partnerId: p.id })).toHaveLength(1);
  });

  it('expired offer → 409 OFFER_EXPIRED; someone else\'s offer → 404', async () => {
    const p = await createPartner(h, { location: at(0.2, 0) });
    const other = await createPartner(h, { location: at(0.3, 0) });
    const { job } = await createJob(h);
    await runDispatchTick(h.ctx);
    const offer = await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: p._id }).lean();

    const notMine = await request(server).post(`/api/v1/deliveries/offers/${offer!._id.toString()}/accept`).set(bearer(await h.token(other.userId)));
    expect(notMine.status).toBe(404);

    h.clock.advance(46_000);
    const late = await request(server).post(`/api/v1/deliveries/offers/${offer!._id.toString()}/accept`).set(bearer(await h.token(p.userId)));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_EXPIRED');
  });

  it('offline partner cannot accept (step 3 fails → CAPACITY_EXCEEDED, nothing committed)', async () => {
    const p = await createPartner(h, { location: at(0.2, 0) });
    const { job } = await createJob(h);
    await runDispatchTick(h.ctx);
    await h.ctx.models.Partner.updateOne({ _id: p._id }, { $set: { online: false } });
    const offer = await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: p._id }).lean();
    const res = await request(server).post(`/api/v1/deliveries/offers/${offer!._id.toString()}/accept`).set(bearer(await h.token(p.userId)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_EXCEEDED');
    expect((await h.ctx.models.Job.findById(job.id).lean())!.status).toBe('OFFERED');
    expect((await h.ctx.models.Offer.findById(offer!._id).lean())!.status).toBe('OFFERED');
  });
});
