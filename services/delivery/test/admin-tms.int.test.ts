import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, outboxEvents, setup, type Harness } from './helpers.js';

describe('admin TMS', () => {
  let h: Harness;
  let admin: string;
  beforeAll(async () => {
    h = await setup('admin_tms');
    admin = await h.adminToken();
  });
  afterAll(async () => h.cleanup());

  it('manual assign only to an APPROVED online partner with capacity; cancels live offers; audit + delivery.assigned', async () => {
    const offered = await createPartner(h, { location: at(0.2, 0) });
    const target = await createPartner(h, { location: at(5, 5) });
    const offline = await createPartner(h, { location: at(0.1, 0), online: false });
    const pending = await createPartner(h, { location: at(0.1, 0), status: 'APPROVAL_PENDING', online: false });
    const { job } = await createJob(h);
    await runDispatchTick(h.ctx);
    expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'OFFERED' })).toBeGreaterThan(0);

    const off = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: offline.id });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('CONFLICT');
    const notApproved = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: pending.id });
    expect(notApproved.status).toBe(403);
    expect(notApproved.body.error.code).toBe('PARTNER_NOT_APPROVED');
    const full = await createPartner(h, { location: at(0.1, 0), maxActive: 0 });
    const cap = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: full.id });
    expect(cap.status).toBe(409);
    expect(cap.body.error.code).toBe('CAPACITY_EXCEEDED');
    // nothing changed by the failed attempts
    expect((await h.ctx.models.Job.findById(job.id).lean())!.status).toBe('OFFERED');

    const ok = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: target.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ASSIGNED', partnerId: target.id });
    expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'OFFERED' })).toBe(0);
    expect((await h.ctx.models.Offer.findOne({ jobId: job._id, partnerId: offered._id }).lean())!.status).toBe('CANCELLED');
    expect((await h.ctx.models.Partner.findById(target._id).lean())!.activeJobIds.map(String)).toEqual([job.id]);
    expect(await outboxEvents(h, 'delivery.assigned', { jobId: job.id, partnerId: target.id })).toHaveLength(1);
    expect(await outboxEvents(h, 'audit.recorded', { targetId: job.id, action: 'delivery.assign' })).toHaveLength(1);
  });

  it('reassign unassigns the previous partner (capacity released) and assigns the new one', async () => {
    const first = await createPartner(h, { location: at(0.2, 0) });
    const second = await createPartner(h, { location: at(0.3, 0) });
    const { job } = await createJob(h);
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: first.id });
    const re = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: second.id });
    expect(re.status).toBe(200);
    expect(re.body.partnerId).toBe(second.id);
    expect((await h.ctx.models.Partner.findById(first._id).lean())!.activeJobIds).toHaveLength(0);
    expect((await h.ctx.models.Partner.findById(second._id).lean())!.activeJobIds.map(String)).toEqual([job.id]);
    expect(await outboxEvents(h, 'delivery.unassigned', { jobId: job.id })).toHaveLength(1);
    expect(await outboxEvents(h, 'delivery.assigned', { jobId: job.id })).toHaveLength(2);
    const stored = (await h.ctx.models.Job.findById(job.id).lean())!;
    expect(stored.statusHistory.map((s) => s.to)).toEqual(['PENDING_ASSIGNMENT', 'ASSIGNED', 'PENDING_ASSIGNMENT', 'ASSIGNED']);
    expect(stored.statusHistory.at(-1)!.actor).toBe('ADMIN');
  });

  it('unassign returns the job to PENDING_ASSIGNMENT for redispatch; fail requires reason and a picked-up job', async () => {
    const p = await createPartner(h, { location: at(0.2, 0) });
    const { job } = await createJob(h);
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: p.id });
    const un = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/unassign`).set(bearer(admin)).send({ reason: 'Partner bike broke down' });
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({ status: 'PENDING_ASSIGNMENT', partnerId: null });
    expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
    expect(await outboxEvents(h, 'audit.recorded', { targetId: job.id, action: 'delivery.unassign' })).toHaveLength(1);

    const failEarly = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/fail`).set(bearer(admin)).send({ reason: 'Lost' });
    expect(failEarly.status).toBe(409);
    expect(failEarly.body.error.code).toBe('DELIVERY_INVALID_TRANSITION');

    await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: p.id });
    const t = await h.token(p.userId);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(t));
    await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(t)).send({ code: '1234' });
    expect((await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/fail`).set(bearer(admin)).send({})).status).toBe(400);
    const failed = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/fail`).set(bearer(admin)).send({ reason: 'Food spilled in transit' });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('FAILED');
    expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
    expect(await outboxEvents(h, 'delivery.failed', { jobId: job.id })).toHaveLength(1);
    expect(await outboxEvents(h, 'audit.recorded', { targetId: job.id, action: 'delivery.fail' })).toHaveLength(1);
  });

  it('jobs list filters by status/exception; overview counts; non-admin forbidden', async () => {
    const { job } = await createJob(h);
    await h.ctx.models.Job.updateOne({ _id: job._id }, { $set: { exception: true } });
    const list = await request(h.app).get('/api/v1/admin/delivery/jobs?exception=true').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.items.map((j: { id: string }) => j.id)).toEqual([job.id]);
    const byStatus = await request(h.app).get('/api/v1/admin/delivery/jobs?status=FAILED').set(bearer(admin));
    expect(byStatus.body.items.every((j: { status: string }) => j.status === 'FAILED')).toBe(true);

    const ov = await request(h.app).get('/api/v1/admin/delivery/overview').set(bearer(admin));
    expect(ov.status).toBe(200);
    expect(ov.body.exceptions).toBe(1);
    expect(ov.body.jobsByStatus.FAILED).toBe(1);
    expect(ov.body.partners.online).toBeGreaterThan(0);

    const forbidden = await request(h.app).get('/api/v1/admin/delivery/jobs').set(bearer(await h.token(job.partnerUserId ?? 'u1')));
    expect(forbidden.status).toBe(403);
  });
});
