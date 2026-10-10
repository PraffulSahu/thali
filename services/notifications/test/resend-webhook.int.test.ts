import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, oid, svixHeaders as svix, type Harness } from './helpers.js';

describe('POST /api/v1/webhooks/resend', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness('resend_wh');
  });
  afterAll(async () => {
    await h.close();
  });

  const sentEmail = async (emailId: string) => {
    const { id } = await h.dispatcher.enqueue({ channel: 'EMAIL', template: 'order_delivered', to: 'asha@example.com', data: {}, dedupeKey: `rs:${oid()}` });
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'SENT', providerMessageId: emailId, provider: 'resend', attempts: 1 } });
    return id;
  };
  const event = (type: string, emailId: string) => JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: ['asha@example.com'], subject: 'x' } });
  const post = (body: string, headers: Record<string, string>) => request(h.app).post('/api/v1/webhooks/resend').set('content-type', 'application/json').set(headers).send(body);

  it('valid svix signature: email.delivered updates the notification by email_id', async () => {
    const emailId = `em_${oid()}`;
    const id = await sentEmail(emailId);
    const body = event('email.delivered', emailId);
    const res = await post(body, svix(body));
    expect(res.status).toBe(200);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');
  });

  it('signature is over the exact raw bytes (whitespace-variant body verifies; re-serialized body does not)', async () => {
    const emailId = `em_${oid()}`;
    const id = await sentEmail(emailId);
    const body = `{ "type" : "email.delivered",\n  "data": { "email_id" : "${emailId}" } }`;
    expect((await post(body, svix(body))).status).toBe(200);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');

    const id2 = await sentEmail(`em_${oid()}`);
    const compact = JSON.stringify(JSON.parse(body));
    const res = await post(compact, svix(body)); // signed the pretty one, sent the compact one
    expect(res.status).toBe(401);
    expect((await h.models.Notification.findById(id2).lean())!.status).toBe('SENT');
  });

  it('bad signature, wrong secret, missing headers -> 401 and no state change', async () => {
    const emailId = `em_${oid()}`;
    const id = await sentEmail(emailId);
    const body = event('email.delivered', emailId);
    expect((await post(body, { ...svix(body), 'svix-signature': 'v1,AAAA' })).status).toBe(401);
    expect((await post(body, svix(body, { secret: `whsec_${Buffer.from('x'.repeat(24)).toString('base64')}` }))).status).toBe(401);
    expect((await post(body, {})).status).toBe(401);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('SENT');
  });

  it('old timestamp (> 5 min) -> 401 even with a valid signature', async () => {
    const emailId = `em_${oid()}`;
    const id = await sentEmail(emailId);
    const body = event('email.delivered', emailId);
    const res = await post(body, svix(body, { ts: Math.floor(Date.now() / 1000) - 600 }));
    expect(res.status).toBe(401);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('SENT');
  });

  it('replay (same svix-id) is idempotent: stored once, no downgrade by a later email.sent', async () => {
    const emailId = `em_${oid()}`;
    const id = await sentEmail(emailId);
    const body = event('email.delivered', emailId);
    const hd = svix(body);
    expect((await post(body, hd)).status).toBe(200);
    expect((await post(body, hd)).status).toBe(200);
    expect(await h.models.ProviderCallback.countDocuments({ 'payload.data.email_id': emailId, provider: 'resend' })).toBe(1);
    const sentBody = event('email.sent', emailId);
    expect((await post(sentBody, svix(sentBody))).status).toBe(200);
    expect((await h.models.Notification.findById(id).lean())!.status).toBe('DELIVERED');
  });

  it('bounce / failed -> DEAD (no automatic resend); complained and delay events leave the status alone', async () => {
    const e1 = `em_${oid()}`;
    const id1 = await sentEmail(e1);
    const b1 = event('email.bounced', e1);
    expect((await post(b1, svix(b1))).status).toBe(200);
    expect(await h.models.Notification.findById(id1).lean()).toMatchObject({ status: 'DEAD', nextAttemptAt: null });

    const e2 = `em_${oid()}`;
    const id2 = await sentEmail(e2);
    for (const t of ['email.delivery_delayed', 'email.opened', 'email.clicked']) {
      const b = event(t, e2);
      expect((await post(b, svix(b))).status).toBe(200);
    }
    expect((await h.models.Notification.findById(id2).lean())!.status).toBe('SENT');
  });

  it('unknown email_id is acknowledged; malformed signed JSON is a 400; unknown event types are ignored', async () => {
    const b = event('email.delivered', 'em_unknown');
    expect((await post(b, svix(b))).status).toBe(200);
    const bad = '{not json';
    expect((await post(bad, svix(bad))).status).toBe(400);
    const other = JSON.stringify({ type: 'contact.created', data: {} });
    expect((await post(other, svix(other))).status).toBe(200);
  });
});
