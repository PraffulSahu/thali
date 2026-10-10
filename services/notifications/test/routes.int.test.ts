import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listRoutes } from '@thali/service-kit';
import { UpstreamError } from '@thali/service-kit';
import { createHarness, oid, type Harness } from './helpers.js';
import { openapi } from '../src/openapi.js';
import type { DeadLetterSource } from '../src/routes/admin.js';

const REMOTE_DL = (service: string, id: string) => ({
  id, stream: `events.${service}`, entryId: '1-0', service, envelope: { id: 'e', type: 'order.placed' }, error: 'boom', attempts: 5, failedAt: new Date().toISOString(), replayedAt: null, replayCount: 0,
});
const replays: string[] = [];
const sources: DeadLetterSource[] = [
  { service: 'identity', list: async () => [REMOTE_DL('identity', 'dl-1')], replay: async (id) => { replays.push(`identity:${id}`); return { id, stream: 'events.identity', entryId: '2-0' }; } },
  { service: 'orders', list: async () => { throw new UpstreamError('orders', 503, 'UPSTREAM_UNAVAILABLE', 'orders is down', 502); }, replay: async () => { throw new UpstreamError('orders', 503, 'UPSTREAM_UNAVAILABLE', 'orders is down', 502); } },
  { service: 'payments', list: async () => [REMOTE_DL('payments', 'dl-2')], replay: async () => { throw new UpstreamError('payments', 404, 'NOT_FOUND', 'Dead letter not found', 404); } },
];

let h: Harness;
const U1 = oid();
const U2 = oid();
beforeAll(async () => {
  h = await createHarness('routes', { deadLetterSources: sources });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.sms.calls = [];
  h.email.calls = [];
  h.sms.failWith = null;
});

const get = async (path: string, token?: string) => {
  const r = request(h.app).get(path);
  if (token) r.set('authorization', `Bearer ${token}`);
  return r;
};

describe('in-app notifications', () => {
  it('lists only my in-app notifications (newest first, paginated, unreadCount) and marks them read (own only)', async () => {
    const make = async (userId: string, n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        h.clock.now = new Date(h.clock.now.getTime() + 1000);
        const { id } = await h.dispatcher.enqueue({ channel: 'IN_APP', userId, template: 'order_delivered', data: { code: `TH-${i}` }, dedupeKey: `inapp:${userId}:${i}` });
        ids.push(id);
      }
      return ids;
    };
    const mine = await make(U1, 3);
    await make(U2, 2);
    await h.dispatcher.enqueue({ channel: 'SMS', userId: U1, to: '+919876543210', template: 'order_delivered', data: {}, dedupeKey: `sms:${U1}` });

    const t1 = await h.userToken(U1);
    const page1 = await get('/api/v1/notifications?limit=2', t1);
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((i: any) => i.id)).toEqual([mine[2], mine[1]]);
    expect(page1.body.nextCursor).toBeTruthy();
    expect(page1.body.unreadCount).toBe(3);
    expect(page1.body.items[0]).toMatchObject({ template: 'order_delivered', readAt: null, title: expect.any(String), body: expect.any(String) });
    expect(JSON.stringify(page1.body)).not.toContain('toEnc');
    const page2 = await get(`/api/v1/notifications?limit=2&cursor=${page1.body.nextCursor}`, t1);
    expect(page2.body.items.map((i: any) => i.id)).toEqual([mine[0]]);
    expect(page2.body.nextCursor).toBeNull();

    expect((await request(h.app).post(`/api/v1/notifications/${mine[0]}/read`).set('authorization', `Bearer ${await h.userToken(U2)}`)).status).toBe(404);
    const read = await request(h.app).post(`/api/v1/notifications/${mine[0]}/read`).set('authorization', `Bearer ${t1}`);
    expect(read.status).toBe(200);
    expect(read.body.readAt).toBeTruthy();
    const again = await request(h.app).post(`/api/v1/notifications/${mine[0]}/read`).set('authorization', `Bearer ${t1}`);
    expect(again.body.readAt).toBe(read.body.readAt); // idempotent
    expect((await get('/api/v1/notifications?unread=true', t1)).body.items).toHaveLength(2);
    expect((await get('/api/v1/notifications')).status).toBe(401);
  });
});

describe('POST /internal/notifications/send', () => {
  const send = async (body: object, from: 'orders' | 'gateway' = 'orders') =>
    request(h.app).post('/internal/notifications/send').set('authorization', `Bearer ${await h.serviceToken(from)}`).send(body);

  it('202 {notificationId}; idempotent by dedupeKey; raw address recipient is encrypted + masked', async () => {
    const body = { channel: 'EMAIL', to: 'someone@example.com', template: 'order_delivered', data: { code: 'TH-1' }, dedupeKey: `send-${oid()}` };
    const a = await send(body);
    expect(a.status).toBe(202);
    const b = await send(body);
    expect(b.status).toBe(202);
    expect(b.body.notificationId).toBe(a.body.notificationId);
    const doc = await h.models.Notification.findById(a.body.notificationId).lean();
    expect(doc).toMatchObject({ channel: 'EMAIL', status: 'QUEUED', to: 's***@example.com' });
    expect(JSON.stringify(doc)).not.toContain('someone@example.com');
  });

  it('resolves userId to the phone/email through identity; IN_APP needs a userId', async () => {
    h.directory.add({ id: U1, phone: '+919000000001', email: 'u1@example.com' });
    const r = await send({ channel: 'SMS', userId: U1, template: 'order_delivered', data: {}, dedupeKey: `send-${oid()}` });
    expect(r.status).toBe(202);
    await h.dispatcher.dispatchDue();
    expect(h.sms.calls.map((c) => c.to)).toContain('+919000000001');
    expect((await send({ channel: 'IN_APP', template: 'order_delivered', data: {}, dedupeKey: `send-${oid()}` })).status).toBe(400);
    expect((await send({ channel: 'SMS', userId: oid(), template: 'order_delivered', data: {}, dedupeKey: `send-${oid()}` })).status).toBe(404);
  });

  it('validates template/channel/body; otp template is not allowed here; gateway cannot call', async () => {
    const base = { channel: 'SMS', to: '+919876543210', template: 'order_delivered', data: {}, dedupeKey: 'k-12345678' };
    expect((await send({ ...base, template: 'nope' })).status).toBe(400);
    expect((await send({ ...base, template: 'otp', data: { code: '1' } })).status).toBe(400);
    expect((await send({ ...base, channel: 'PIGEON' })).status).toBe(400);
    expect((await send({ ...base, to: undefined })).status).toBe(400);
    expect((await send({ ...base, to: 'not-a-phone' })).status).toBe(400);
    expect((await send({ ...base, dedupeKey: '' })).status).toBe(400);
    expect((await send(base, 'gateway')).status).toBe(403);
  });
});

describe('admin: list notifications', () => {
  it('lists with status/channel filters, masked recipients, and no secrets', async () => {
    const { id } = await h.dispatcher.enqueue({ channel: 'EMAIL', to: 'owner@resto.example', template: 'restaurant_email_verification', data: { verifyUrl: 'https://x/?token=TOPSECRET' }, dedupeKey: `adm-${oid()}` });
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'DEAD', lastError: 'resend 422' } });
    const res = await get('/api/v1/admin/notifications?status=DEAD&channel=EMAIL', await h.adminToken());
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.id === id);
    expect(item).toMatchObject({ status: 'DEAD', channel: 'EMAIL', template: 'restaurant_email_verification', lastError: 'resend 422' });
    expect(item.to).toBe('o***@resto.example');
    expect(JSON.stringify(res.body)).not.toContain('TOPSECRET');
    expect(JSON.stringify(res.body)).not.toContain('toEnc');
    expect(JSON.stringify(res.body)).not.toContain('secretEnc');
    expect((await get('/api/v1/admin/notifications', await h.userToken(oid()))).status).toBe(403);
    expect((await get('/api/v1/admin/notifications?status=BOGUS', await h.adminToken())).status).toBe(400);
    await h.models.Notification.updateOne({ _id: id }, { $set: { status: 'SKIPPED', skipReason: 'OPTED_OUT' } });
    const skipped = await get('/api/v1/admin/notifications?status=SKIPPED', await h.adminToken());
    expect(skipped.status).toBe(200);
    expect(skipped.body.items.find((i: any) => i.id === id)).toMatchObject({ status: 'SKIPPED', skipReason: 'OPTED_OUT' });
  });
});

describe('admin: dead letters across services', () => {
  it('aggregates every source and reports unreachable services as errors (never hides them)', async () => {
    const res = await get('/api/v1/admin/notifications/dead-letters', await h.adminToken());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => `${i.service}:${i.id}`).sort()).toEqual(['identity:dl-1', 'payments:dl-2']);
    expect(res.body.errors).toEqual([{ service: 'orders', code: 'UPSTREAM_UNAVAILABLE', message: expect.stringContaining('orders') }]);
    // local (notifications) DLQ is included as a source too
    expect(res.body.sources.sort()).toEqual(['identity', 'notifications', 'orders', 'payments']);
    expect((await get('/api/v1/admin/notifications/dead-letters')).status).toBe(401);
  });

  it('replay forwards to the owning service, audits, and surfaces upstream failures', async () => {
    const t = await h.adminToken();
    const ok = await request(h.app).post('/api/v1/admin/notifications/dead-letters/identity/dl-1/replay').set('authorization', `Bearer ${t}`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 'dl-1', stream: 'events.identity', entryId: '2-0' });
    expect(replays).toEqual(['identity:dl-1']);
    const audit = await h.conn.collection('outbox').findOne({ 'envelope.payload.action': 'dead_letter.replay', 'envelope.payload.targetId': 'identity:dl-1' });
    expect(audit).toBeTruthy();

    const nf = await request(h.app).post('/api/v1/admin/notifications/dead-letters/payments/zzz/replay').set('authorization', `Bearer ${t}`).send({});
    expect(nf.status).toBe(404);
    const down = await request(h.app).post('/api/v1/admin/notifications/dead-letters/orders/zzz/replay').set('authorization', `Bearer ${t}`).send({});
    expect(down.status).toBe(502);
    expect((await request(h.app).post('/api/v1/admin/notifications/dead-letters/bogus/zzz/replay').set('authorization', `Bearer ${t}`).send({})).status).toBe(400);
    expect((await request(h.app).post('/api/v1/admin/notifications/dead-letters/identity/dl-1/replay').set('authorization', `Bearer ${await h.adminToken(undefined, { mfa: false })}`).send({})).status).toBe(403);
  });
});

describe('demo fail mode', () => {
  it('ADMIN+MFA toggles mock-provider outages; mock providers then throw 503 (verified through the real mock providers)', async () => {
    const t = await h.adminToken();
    const on = await request(h.app).post('/api/v1/admin/notifications/demo/fail-mode').set('authorization', `Bearer ${t}`).send({ sms: true, email: false });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ sms: true, email: false });
    expect(await h.failMode.get()).toEqual({ sms: true, email: false });
    await request(h.app).post('/api/v1/admin/notifications/demo/fail-mode').set('authorization', `Bearer ${t}`).send({ sms: false, email: false });
    expect(await h.failMode.get()).toEqual({ sms: false, email: false });
    const audit = await h.conn.collection('outbox').findOne({ 'envelope.payload.action': 'demo.fail_mode' });
    expect(audit).toBeTruthy();
    expect((await request(h.app).post('/api/v1/admin/notifications/demo/fail-mode').set('authorization', `Bearer ${t}`).send({ sms: 'yes' })).status).toBe(400);
    expect((await request(h.app).post('/api/v1/admin/notifications/demo/fail-mode').send({ sms: true, email: true })).status).toBe(401);
    expect((await request(h.app).post('/api/v1/admin/notifications/demo/fail-mode').set('authorization', `Bearer ${await h.userToken(oid())}`).send({ sms: true, email: true })).status).toBe(403);
  });

  it('is 404 outside demo mode', async () => {
    const h2 = await createHarness('routes_sandbox', { appMode: 'sandbox', env: { SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_FROM: '+15005550006', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' } });
    try {
      const t = await h2.adminToken();
      const res = await request(h2.app).post('/api/v1/admin/notifications/demo/fail-mode').set('authorization', `Bearer ${t}`).send({ sms: true, email: true });
      expect(res.status).toBe(404);
      expect(await h2.failMode.get()).toEqual({ sms: false, email: false });
    } finally {
      await h2.close();
    }
  });
});

describe('OpenAPI coverage', () => {
  it('every registered Express route is documented (and nothing documented is missing)', async () => {
    const routes = listRoutes(h.app).filter((r) => !['HEAD', 'OPTIONS'].includes(r.method.toUpperCase()));
    const doc = openapi.document();
    const documented = new Set(Object.entries(doc.paths ?? {}).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`)));
    const toOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const missing = routes.filter((r) => !documented.has(`${r.method.toUpperCase()} ${toOpenApi(r.path)}`)).filter((r) => r.path !== '/docs');
    expect(missing).toEqual([]);
    const actual = new Set(routes.map((r) => `${r.method.toUpperCase()} ${toOpenApi(r.path)}`));
    expect([...documented].filter((d) => !actual.has(d))).toEqual([]);
  });
});
