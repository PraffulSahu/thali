/** DLV-7 admin assign picker: online / hasCapacity filters, nearJobId distance sort, row extras; history index. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bearer, createJob, createPartner, oid, setup, type Harness } from './helpers.js';

describe('DLV-7 assign picker', () => {
  let h: Harness;
  let admin: string;
  beforeAll(async () => {
    h = await setup('assign_picker');
    admin = await h.adminToken();
  });
  afterAll(async () => h.cleanup());

  const list = (query: Record<string, string | number>) => request(h.app).get('/api/v1/admin/delivery/partners').query(query).set(bearer(admin));

  it('nearJobId sorts by distance to the job pickup; online + hasCapacity filter; rows carry distance, activeJobCount, lastLocationAt', async () => {
    const pickup = at(10, 10); // away from every other test's partners
    const near = await createPartner(h, { location: at(0.5, 0, pickup), name: 'Near One' });
    const mid = await createPartner(h, { location: at(2, 0, pickup), name: 'Mid Two' });
    const far = await createPartner(h, { location: at(6, 0, pickup), name: 'Far Three' });
    const offline = await createPartner(h, { location: at(0.2, 0, pickup), online: false, name: 'Offline Four' });
    const full = await createPartner(h, { location: at(1, 0, pickup), maxActive: 1, name: 'Full Five' });
    const { job: busyJob } = await createJob(h, { pickupAt: at(1, 0.1, pickup) });
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${busyJob.id}/assign`).set(bearer(admin)).send({ partnerId: full.id }).expect(200);
    const { job } = await createJob(h, { pickupAt: pickup });

    const all = await list({ nearJobId: job.id, limit: 5 });
    expect(all.status).toBe(200);
    expect(all.body.items.map((p: { id: string }) => p.id)).toEqual([offline.id, near.id, full.id, mid.id, far.id]);
    expect(all.body.nextCursor).toBeNull();
    const nearRow = all.body.items[1];
    expect(nearRow.distanceToPickupKm).toBeCloseTo(0.5, 1);
    expect(nearRow).toMatchObject({ activeJobCount: 0, online: true, name: 'Near One' });
    expect(nearRow.lastLocationAt).toEqual(expect.any(String));
    expect(all.body.items[2]).toMatchObject({ id: full.id, activeJobCount: 1 });

    const picker = await list({ nearJobId: job.id, online: 'true', hasCapacity: 'true', status: 'APPROVED', limit: 3 });
    expect(picker.body.items.map((p: { id: string }) => p.id)).toEqual([near.id, mid.id, far.id]);

    const atCapacity = await list({ nearJobId: job.id, hasCapacity: 'false' });
    expect(atCapacity.body.items.map((p: { id: string }) => p.id)).toEqual([full.id]);
  });

  it('without nearJobId: filters still apply, distance is null, cursor paging works', async () => {
    const res = await list({ online: 'false', limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((p: { online: boolean; distanceToPickupKm: number | null }) => !p.online && p.distanceToPickupKm === null)).toBe(true);
    const p1 = await list({ online: 'true', limit: 2 });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await list({ online: 'true', limit: 2, cursor: p1.body.nextCursor });
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  it('unknown nearJobId → 404; bad flag → 400', async () => {
    expect((await list({ nearJobId: oid() })).status).toBe(404);
    expect((await list({ online: 'yes' })).status).toBe(400);
  });

  it('history query uses the {partnerUserId, createdAt, _id} index', async () => {
    const idx = await h.ctx.models.Job.collection.indexes();
    expect(idx.some((i) => JSON.stringify(i.key) === JSON.stringify({ partnerUserId: 1, createdAt: -1, _id: -1 }))).toBe(true);
  });
});
