import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, bearer, createJob, oid, outboxEvents, setup, type Harness } from './helpers.js';

const vehicle = { type: 'SCOOTER', registrationNumber: 'KA05MN4321' };

async function uploadDoc(h: Harness, token: string, type: string) {
  const pre = await request(h.app).post('/api/v1/partner/uploads').set(bearer(token)).send({ type, contentType: 'image/png', sizeBytes: 1200 });
  expect(pre.status).toBe(200);
  h.storage.put(pre.body.key);
  const doc = await request(h.app).post('/api/v1/partner/documents').set(bearer(token)).send({ type, key: pre.body.key });
  expect(doc.status).toBe(200);
  return doc.body;
}

describe('partner onboarding & approval (LLD 4.7)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('onboarding');
  });
  afterAll(async () => h.cleanup());

  it('full flow: profile (role grant) → missing docs 422 → submit → not approved 403 → admin approve → online → suspend forces offline', async () => {
    const userId = oid();
    h.identity.addUser({ id: userId, name: 'Imran Pasha', phone: '+919811112222' });
    const token = await h.token(userId);

    const created = await request(h.app).post('/api/v1/partner/profile').set(bearer(token)).send({ vehicle });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userId, name: 'Imran Pasha', phone: '+919811112222', status: 'DRAFT', online: false, vehicle });
    expect(h.identity.grants).toContainEqual({ userId, role: 'DELIVERY_PARTNER' });

    // idempotent re-create returns the same profile (and re-attempts the grant)
    const again = await request(h.app).post('/api/v1/partner/profile').set(bearer(token)).send({ vehicle });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);

    // submit without documents → 422
    const early = await request(h.app).post('/api/v1/partner/submit').set(bearer(token));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PARTNER_PROFILE_INCOMPLETE');
    expect(early.body.error.details.missing).toEqual(expect.arrayContaining(['ID_PROOF', 'DRIVING_LICENSE', 'VEHICLE_RC']));

    // presign passes the declared size as signed contentLength
    const tooBig = await request(h.app).post('/api/v1/partner/uploads').set(bearer(token)).send({ type: 'ID_PROOF', contentType: 'image/png', sizeBytes: 50 * 1024 * 1024 });
    expect(tooBig.status).toBe(400);
    await uploadDoc(h, token, 'ID_PROOF');
    expect(h.storage.calls.presignPut.at(-1)).toMatchObject({ contentLength: 1200, contentType: 'image/png' });

    // a key outside the partner's own prefix is refused
    const foreign = await request(h.app).post('/api/v1/partner/documents').set(bearer(token)).send({ type: 'VEHICLE_RC', key: `partner-kyc/${oid()}/x.png` });
    expect(foreign.status).toBe(403);

    // still missing two documents
    const partial = await request(h.app).post('/api/v1/partner/submit').set(bearer(token));
    expect(partial.status).toBe(422);
    expect(partial.body.error.details.missing).toEqual(['DRIVING_LICENSE', 'VEHICLE_RC']);

    await uploadDoc(h, token, 'DRIVING_LICENSE');
    const last = await uploadDoc(h, token, 'VEHICLE_RC');
    // demo mode marks documents demoVerified …
    expect(last.documents.every((d: { demoVerified: boolean }) => d.demoVerified)).toBe(true);

    const submitted = await request(h.app).post('/api/v1/partner/submit').set(bearer(token));
    expect(submitted.status).toBe(200);
    // … but never auto-approves
    expect(submitted.body.status).toBe('APPROVAL_PENDING');
    const stored = await h.ctx.models.Partner.findById(created.body.id).lean();
    expect(stored!.status).toBe('APPROVAL_PENDING');
    expect(await outboxEvents(h, 'partner.status_changed', { partnerId: created.body.id, to: 'APPROVAL_PENDING' })).toHaveLength(1);

    // not approved → cannot go online
    const blocked = await request(h.app).post('/api/v1/partner/online').set(bearer(token)).send(at(0, 0));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PARTNER_NOT_APPROVED');

    // admin approve requires MFA
    const noMfa = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/approve`).set(bearer(await h.adminToken({ mfa: false })));
    expect(noMfa.status).toBe(403);
    const admin = await h.adminToken();
    const approved = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/approve`).set(bearer(admin));
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(await outboxEvents(h, 'audit.recorded', { targetId: created.body.id, action: 'partner.approve' })).toHaveLength(1);

    const online = await request(h.app).post('/api/v1/partner/online').set(bearer(token)).send(at(0.2, 0));
    expect(online.status).toBe(200);
    expect(online.body.online).toBe(true);

    // assign a job, then suspend while online → forced offline, unpicked job returned to the pool
    const { job } = await createJob(h);
    const assigned = await request(h.app).post(`/api/v1/admin/delivery/jobs/${job.id}/assign`).set(bearer(admin)).send({ partnerId: created.body.id });
    expect(assigned.status).toBe(200);

    const noReason = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/suspend`).set(bearer(admin)).send({});
    expect(noReason.status).toBe(400);
    const suspended = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/suspend`).set(bearer(admin)).send({ reason: 'Repeated customer complaints' });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ status: 'SUSPENDED', online: false, activeJobIds: [] });
    const back = await h.ctx.models.Job.findById(job.id).lean();
    expect(back!.status).toBe('PENDING_ASSIGNMENT');
    expect(back!.partnerId ?? null).toBeNull();
    expect(await outboxEvents(h, 'delivery.unassigned', { jobId: job.id })).toHaveLength(1);

    const blockedAgain = await request(h.app).post('/api/v1/partner/online').set(bearer(token)).send(at(0, 0));
    expect(blockedAgain.status).toBe(403);

    const reinstated = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/reinstate`).set(bearer(admin));
    expect(reinstated.body).toMatchObject({ status: 'APPROVED', online: false });
  });

  it('reject with reason → resubmit returns to APPROVAL_PENDING; invalid transition 409', async () => {
    const userId = oid();
    h.identity.addUser({ id: userId });
    const token = await h.token(userId);
    const created = await request(h.app).post('/api/v1/partner/profile').set(bearer(token)).send({ name: 'Kiran', vehicle: { type: 'BICYCLE', registrationNumber: 'NONE-001' } });
    expect(created.body.name).toBe('Kiran');
    // bicycles only need an ID proof
    await uploadDoc(h, token, 'ID_PROOF');
    expect((await request(h.app).post('/api/v1/partner/submit').set(bearer(token))).body.status).toBe('APPROVAL_PENDING');

    const admin = await h.adminToken();
    const approveDraft = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/reinstate`).set(bearer(admin));
    expect(approveDraft.status).toBe(409);
    expect(approveDraft.body.error.code).toBe('PARTNER_INVALID_TRANSITION');

    const rejected = await request(h.app).post(`/api/v1/admin/delivery/partners/${created.body.id}/reject`).set(bearer(admin)).send({ reason: 'ID proof is blurry' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', statusReason: 'ID proof is blurry' });
    const resubmitted = await request(h.app).post('/api/v1/partner/submit').set(bearer(token));
    expect(resubmitted.body.status).toBe('APPROVAL_PENDING');

    const list = await request(h.app).get('/api/v1/admin/delivery/partners?status=APPROVAL_PENDING').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(created.body.id);

    const docId = (await h.ctx.models.Partner.findById(created.body.id).lean())!.documents[0]!._id.toString();
    const url = await request(h.app).get(`/api/v1/admin/delivery/partners/${created.body.id}/documents/${docId}/url`).set(bearer(admin));
    expect(url.status).toBe(200);
    expect(url.body.url).toContain('sig=');
    expect(h.storage.calls.presignGet.at(-1)).toMatchObject({ expiresSec: 300 });
  });

  it('GET profile 404 before creation; other users cannot see it', async () => {
    const res = await request(h.app).get('/api/v1/partner/profile').set(bearer(await h.token(oid())));
    expect(res.status).toBe(404);
  });
});

describe('partner onboarding outside demo mode', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('onboarding_sandbox', { APP_MODE: 'sandbox' });
  });
  afterAll(async () => h.cleanup());

  it('documents are NOT demoVerified in sandbox', async () => {
    const userId = oid();
    h.identity.addUser({ id: userId });
    const token = await h.token(userId);
    await request(h.app).post('/api/v1/partner/profile').set(bearer(token)).send({ vehicle });
    const doc = await uploadDoc(h, token, 'ID_PROOF');
    expect(doc.documents[0].demoVerified).toBe(false);
  });
});
