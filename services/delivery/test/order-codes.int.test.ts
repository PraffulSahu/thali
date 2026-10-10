/** DLV-4 order codes on jobs: stored from order.accepted, shown to partner + admin, searchable, backfilled. */
import request from 'supertest';
import { UpstreamError } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCodeBackfill, startCodeBackfill } from '../src/jobs/code-backfill.js';
import { at, bearer, createJob, createPartner, setup, type Harness } from './helpers.js';

describe('DLV-4 order codes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('order_codes');
  });
  afterAll(async () => h.cleanup());

  const unique = () => Math.random().toString(36).slice(2, 10).toUpperCase();

  it('codes from order.accepted appear on partner + admin views', async () => {
    const code = `TH-${unique()}`;
    const p = await createPartner(h, { location: at(0.1, 0) });
    const { job } = await createJob(h, { childOrderCode: code, checkoutCode: 'TH-CHECKOUT1' });
    const admin = await h.adminToken();
    const assigned = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: p.id });
    expect(assigned.body).toMatchObject({ childOrderCode: code, checkoutCode: 'TH-CHECKOUT1' });
    const active = await request(h.app).get('/api/v1/deliveries/active').set(bearer(await h.token(p.userId)));
    expect(active.body.items[0]).toMatchObject({ childOrderCode: code, checkoutCode: 'TH-CHECKOUT1' });
  });

  it('admin search: TH- prefix (child or checkout code, case-insensitive), ids', async () => {
    const tag = unique();
    const { job: a } = await createJob(h, { childOrderCode: `TH-${tag}A`, checkoutCode: `TH-${tag}G` });
    const { job: b } = await createJob(h, { childOrderCode: `TH-${tag}B`, checkoutCode: `TH-${tag}G` });
    await createJob(h, { childOrderCode: `TH-${unique()}`, checkoutCode: `TH-${unique()}` });
    const admin = await h.adminToken();
    const search = async (q: string) =>
      ((await request(h.app).get('/api/v1/admin/delivery/jobs').query({ q }).set(bearer(admin))).body.items as { id: string }[]).map((j) => j.id).sort();

    expect(await search(`th-${tag.toLowerCase()}a`)).toEqual([a.id]);
    expect(await search(`TH-${tag}G`)).toEqual([a.id, b.id].sort());
    expect(await search(`TH-${tag}`)).toEqual([a.id, b.id].sort());
    expect(await search(a.childOrderId)).toEqual([a.id]);
    expect(await search(a.id)).toEqual([a.id]);
    expect(await search('TH-.*')).toEqual([]); // regex metacharacters are literal

    // search + pagination cursor combine
    const page1 = await request(h.app).get('/api/v1/admin/delivery/jobs').query({ q: `TH-${tag}`, limit: 1 }).set(bearer(admin));
    expect(page1.body.items).toHaveLength(1);
    const page2 = await request(h.app).get('/api/v1/admin/delivery/jobs').query({ q: `TH-${tag}`, limit: 1, cursor: page1.body.nextCursor }).set(bearer(admin));
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it('backfill: fills codes from orders, marks 404s, stops when orders is down and resumes later; idempotent', async () => {
    await h.ctx.models.Job.updateMany({ childOrderCode: { $ne: null } }, { $set: { codesCheckedAt: new Date() } }); // isolate from earlier tests
    const { job: old1 } = await createJob(h);
    const { job: old2 } = await createJob(h);
    const { job: gone } = await createJob(h);
    h.orders.children.set(old1.childOrderId, { id: old1.childOrderId, code: 'TH-OLD00001' });
    h.orders.children.set(old2.childOrderId, { id: old2.childOrderId, code: 'TH-OLD00002', checkoutCode: 'TH-GRP00002' });

    // orders unavailable: nothing changes, run reports interruption
    h.orders.state.fail = new UpstreamError('orders', 0, 'UPSTREAM_UNAVAILABLE', 'orders unavailable', 502);
    const down = await runCodeBackfill(h.ctx);
    expect(down).toMatchObject({ updated: 0, notFound: 0, interrupted: true });
    expect((await h.ctx.models.Job.findById(old1.id).lean())!.childOrderCode).toBeNull();

    h.orders.state.fail = null;
    const ok = await runCodeBackfill(h.ctx, { batch: 2 });
    expect(ok).toMatchObject({ updated: 2, notFound: 1, interrupted: false });
    expect(await h.ctx.models.Job.findById(old1.id).lean()).toMatchObject({ childOrderCode: 'TH-OLD00001', checkoutCode: null });
    expect(await h.ctx.models.Job.findById(old2.id).lean()).toMatchObject({ childOrderCode: 'TH-OLD00002', checkoutCode: 'TH-GRP00002' });
    const g = (await h.ctx.models.Job.findById(gone.id).lean())!;
    expect(g.childOrderCode).toBeNull();
    expect(g.codesCheckedAt).toBeInstanceOf(Date);

    const calls = h.orders.state.calls;
    expect(await runCodeBackfill(h.ctx)).toMatchObject({ updated: 0, notFound: 0 });
    expect(h.orders.state.calls).toBe(calls); // nothing left to ask
  });

  it('startCodeBackfill runs at boot under the leader lock (one runner across instances)', async () => {
    const { job } = await createJob(h);
    h.orders.children.set(job.childOrderId, { id: job.childOrderId, code: 'TH-BOOT0001' });
    const a = startCodeBackfill(h.ctx);
    const b = startCodeBackfill(h.ctx);
    try {
      await waitFor(async () => (await h.ctx.models.Job.findById(job.id).lean())!.childOrderCode === 'TH-BOOT0001', { message: 'backfilled at boot' });
      expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
