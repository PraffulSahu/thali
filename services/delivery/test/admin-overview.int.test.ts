/** DLV-5 admin overview counts: approved partners, partners on a delivery, unassigned jobs. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, setup, type Harness } from './helpers.js';

describe('DLV-5 overview counts', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('admin_overview');
  });
  afterAll(async () => h.cleanup());

  it('partners.approved, partners.onDelivery, unassigned', async () => {
    const busy = await createPartner(h, { location: at(0.1, 0) });
    await createPartner(h, { location: at(9, 9) }); // approved, online, idle (too far to be offered)
    await createPartner(h, { location: at(0.1, 0), online: false }); // approved, offline
    await createPartner(h, { status: 'APPROVAL_PENDING', online: false });
    const admin = await h.adminToken();

    const { job: assigned } = await createJob(h);
    await request(h.app).post(`/api/v1/admin/delivery/jobs/${assigned.id}/assign`).set(bearer(admin)).send({ partnerId: busy.id }).expect(200);
    await createJob(h, { pickupAt: at(-20, -20) }); // PENDING_ASSIGNMENT (nobody near)
    await createJob(h); // will be OFFERED to `busy` (batch-eligible, same restaurant area)
    await runDispatchTick(h.ctx);

    const ov = await request(h.app).get('/api/v1/admin/delivery/overview').set(bearer(admin));
    expect(ov.status).toBe(200);
    const pending = ov.body.jobsByStatus.PENDING_ASSIGNMENT ?? 0;
    const offered = ov.body.jobsByStatus.OFFERED ?? 0;
    expect(pending + offered).toBe(2);
    expect(ov.body.unassigned).toBe(2);
    expect(ov.body.partners).toMatchObject({ approved: 3, online: 2, onDelivery: 1 });
    expect(ov.body.partners.byStatus).toMatchObject({ APPROVED: 3, APPROVAL_PENDING: 1 });
  });
});
