import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySvixSignature } from '../src/providers/resend-email.js';
import { createHarness, oid, RESEND_SECRET, type Harness } from './helpers.js';

/** Independent Svix signer: base64(HMAC-SHA256(base64decode(secret after whsec_), `${id}.${ts}.${body}`)). */
const svix = (body: string, opts: { id?: string; ts?: number; secret?: string } = {}) => {
  const id = opts.id ?? `msg_${oid()}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? RESEND_SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
};

describe('verifySvixSignature', () => {
  const body = '{"type":"email.delivered"}';
  const now = Date.now();
  it('accepts valid, multi-signature headers and rejects bad ones', () => {
    const hd = svix(body);
    const args = { secret: RESEND_SECRET, id: hd['svix-id'], timestamp: hd['svix-timestamp'], body, now };
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'] })).toBe(true);
    expect(verifySvixSignature({ ...args, signature: `v1,AAAA ${hd['svix-signature']}` })).toBe(true);
    expect(verifySvixSignature({ ...args, signature: 'v1,AAAA' })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'].replace('v1,', 'v2,') })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'], body: `${body} ` })).toBe(false);
    expect(verifySvixSignature({ ...args, signature: hd['svix-signature'], secret: `whsec_${Buffer.from('other-secret-bytes').toString('base64')}` })).toBe(false);
  });
  it('rejects timestamps older or newer than 5 minutes, and non-numeric ones', () => {
    const old = svix(body, { ts: Math.floor(now / 1000) - 301 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: old['svix-id'], timestamp: old['svix-timestamp'], signature: old['svix-signature'], body, now })).toBe(false);
    const edge = svix(body, { ts: Math.floor(now / 1000) - 299 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: edge['svix-id'], timestamp: edge['svix-timestamp'], signature: edge['svix-signature'], body, now })).toBe(true);
    const future = svix(body, { ts: Math.floor(now / 1000) + 400 });
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: future['svix-id'], timestamp: future['svix-timestamp'], signature: future['svix-signature'], body, now })).toBe(false);
    expect(verifySvixSignature({ secret: RESEND_SECRET, id: 'a', timestamp: 'abc', signature: 'v1,x', body, now })).toBe(false);
  });
});

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
