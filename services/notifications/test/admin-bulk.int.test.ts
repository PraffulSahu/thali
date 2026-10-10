import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError, encryptField, writeDeadLetter } from '@thali/service-kit';
import { ENC_KEY, createHarness, oid, type Harness } from './helpers.js';
import type { DeadLetterSource, DeadLetterView } from '../src/routes/admin.js';

const dl = (service: string, id: string, failedAt: string): DeadLetterView => ({
  id, stream: `events.${service}`, entryId: '1-0', service, envelope: { id: 'e' }, error: 'boom', attempts: 5, failedAt, replayedAt: null, replayCount: 0,
});
const replays: string[] = [];
let ordersDown = false;
const sources: DeadLetterSource[] = [
  { service: 'identity', list: async () => [dl('identity', 'i-2', '2026-10-10T09:00:00.000Z'), dl('identity', 'i-1', '2026-10-10T08:00:00.000Z')], replay: async (id) => { replays.push(`identity:${id}`); return { id, stream: 'events.identity', entryId: '2-0' }; } },
  {
    service: 'orders',
    list: async () => { if (ordersDown) throw new UpstreamError('orders', 503, 'UPSTREAM_UNAVAILABLE', 'orders is down', 502); return [dl('orders', 'o-1', '2026-10-10T08:30:00.000Z'), dl('orders', 'o-bad', '2026-10-10T08:40:00.000Z')]; },
    replay: async (id) => { if (id === 'o-bad') throw new UpstreamError('orders', 404, 'NOT_FOUND', 'Dead letter not found', 404); replays.push(`orders:${id}`); return { id, stream: 'events.orders', entryId: '3-0' }; },
  },
];

const providerErrors: { provider: string; message?: string | undefined }[] = [];
let h: Harness;
beforeAll(async () => {
  h = await createHarness('admin-bulk', { deadLetterSources: sources, onProviderError: (provider, message) => providerErrors.push({ provider, message }) });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.models.Notification.deleteMany({});
  replays.length = 0;
  ordersDown = false;
  h.sms.failWith = null;
  h.email.failWith = null;
  await h.conn.collection('outbox').deleteMany({});
});

let seq = 0;
const iso = (m: number) => new Date(Date.parse('2026-10-10T10:00:00.000Z') - m * 60_000);
/** Insert a notification directly in a given state. */
async function seed(over: Record<string, unknown> = {}) {
  const at = (over.createdAt as Date | undefined) ?? iso(60);
  const doc = await h.models.Notification.create({
    channel: 'SMS', to: '+91******3210', toEnc: encryptField('+919876543210', ENC_KEY), template: 'order_delivered', data: {}, status: 'FAILED', attempts: 6,
    nextAttemptAt: null, lastError: 'twilio 503: provider down', provider: 'twilio', dedupeKey: `bulk:${++seq}:${oid()}`, createdAt: at, updatedAt: at, ...over,
  });
  return String(doc._id);
}
const admin = async (mfa = true) => (await h.adminToken(undefined, { mfa })) as string;
const post = async (path: string, body: unknown, token?: string) => request(h.app).post(`/api/v1/admin/notifications${path}`).set('authorization', `Bearer ${token ?? (await admin())}`).send(body as object);
const getSummary = async (token?: string) => request(h.app).get('/api/v1/admin/notifications/summary').set('authorization', `Bearer ${token ?? (await admin())}`);

describe('NTF-1 summary', () => {
  it('counts every status (zero-filled), failures of the last 24 h by channel, and the scrubbed last error', async () => {
    h.clock.now = new Date();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await seed({ status: 'FAILED', channel: 'SMS' });
    await seed({ status: 'DEAD', channel: 'SMS', lastError: 'twilio 400: bad number +919876543210' });
    await seed({ status: 'DEAD', channel: 'EMAIL', template: 'refund_succeeded', provider: 'resend', lastError: 'resend 422: ops@example.com rejected', updatedAt: new Date(Date.now() - 1000) });
    await seed({ status: 'FAILED', channel: 'EMAIL', updatedAt: old, createdAt: old }); // failed long ago: counted in byStatus only
    await seed({ status: 'SENT' });
    await seed({ status: 'SKIPPED', skipReason: 'OPTED_OUT' });
    const res = await getSummary();
    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({ QUEUED: 0, SENDING: 0, SENT: 1, DELIVERED: 0, FAILED: 2, DEAD: 2, SKIPPED: 1 });
    expect(res.body.failedLast24h).toBe(3);
    expect(res.body.byChannel).toEqual({ SMS: { failed: 2 }, EMAIL: { failed: 1 } });
    expect(res.body.lastError).toEqual({ channel: 'EMAIL', provider: 'resend', message: 'resend 422: [email] rejected', at: expect.any(String) });
  });

  it('empty collection: zeros and lastError null; ADMIN + MFA only', async () => {
    const res = await getSummary();
    expect(res.body).toEqual({ byStatus: { QUEUED: 0, SENDING: 0, SENT: 0, DELIVERED: 0, FAILED: 0, DEAD: 0, SKIPPED: 0 }, failedLast24h: 0, byChannel: { SMS: { failed: 0 }, EMAIL: { failed: 0 } }, lastError: null });
    expect((await request(h.app).get('/api/v1/admin/notifications/summary')).status).toBe(401);
    expect((await getSummary(await admin(false))).status).toBe(403);
    expect((await getSummary(await h.userToken(oid()))).status).toBe(403);
  });
});

describe('NTF-2 bulk retry', () => {
  it('re-queues FAILED (not DEAD / SENT / OTP) through the per-id path, audits once, and the rows are then delivered', async () => {
    const a = await seed({ status: 'FAILED' });
    const b = await seed({ status: 'FAILED', channel: 'EMAIL', template: 'membership_activated', toEnc: encryptField('a@example.com', ENC_KEY) });
    const dead = await seed({ status: 'DEAD' });
    const sent = await seed({ status: 'SENT' });
    const otp = await seed({ status: 'FAILED', template: 'otp' });
    h.clock.now = new Date('2026-10-10T10:00:00.000Z');
    const res = await post('/retry', { status: 'FAILED' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: 2 });
    const rows = await h.models.Notification.find({ _id: { $in: [a, b, dead, sent, otp] } }).lean();
    const by = Object.fromEntries(rows.map((r) => [String(r._id), r]));
    expect(by[a]).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(by[a]!.nextAttemptAt!.toISOString()).toBe('2026-10-10T10:00:00.000Z');
    expect(by[b]).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(by[dead]!.status).toBe('DEAD');
    expect(by[sent]!.status).toBe('SENT');
    expect(by[otp]!.status).toBe('FAILED');
    const audits = await h.conn.collection('outbox').find({ 'envelope.payload.action': 'notification.bulk_retry' }).toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.envelope.payload).toMatchObject({ service: 'notifications', actorRole: 'ADMIN:OPS', targetType: 'notification', targetId: 'bulk' });
    expect(audits[0]!.envelope.payload.summary).toContain('Re-queued 2 FAILED');
    expect(await h.dispatcher.dispatchDue()).toBe(1 + 1);
    expect((await h.models.Notification.findById(a).lean())!.status).toBe('SENT');
  });

  it('DEAD, channel, before and limit filters; oldest first', async () => {
    const d1 = await seed({ status: 'DEAD', channel: 'SMS', createdAt: iso(300) });
    const d2 = await seed({ status: 'DEAD', channel: 'SMS', createdAt: iso(200) });
    const d3 = await seed({ status: 'DEAD', channel: 'SMS', createdAt: iso(100) });
    const e1 = await seed({ status: 'DEAD', channel: 'EMAIL', template: 'membership_activated', createdAt: iso(250) });
    expect((await post('/retry', { status: 'DEAD', channel: 'EMAIL' })).body).toEqual({ queued: 1 });
    expect((await h.models.Notification.findById(e1).lean())!.status).toBe('QUEUED');
    expect((await post('/retry', { status: 'DEAD', channel: 'SMS', limit: 1 })).body).toEqual({ queued: 1 });
    expect((await h.models.Notification.findById(d1).lean())!.status).toBe('QUEUED'); // oldest first
    expect((await h.models.Notification.findById(d2).lean())!.status).toBe('DEAD');
    expect((await post('/retry', { status: 'DEAD', before: iso(150).toISOString() })).body).toEqual({ queued: 1 });
    expect((await h.models.Notification.findById(d2).lean())!.status).toBe('QUEUED');
    expect((await h.models.Notification.findById(d3).lean())!.status).toBe('DEAD'); // created after `before`
    expect((await post('/retry', { status: 'DEAD' })).body).toEqual({ queued: 1 });
  });

  it('nothing to retry returns queued 0; validation, auth and MFA are enforced', async () => {
    expect((await post('/retry', { status: 'FAILED' })).body).toEqual({ queued: 0 });
    for (const bad of [{}, { status: 'SENT' }, { status: 'FAILED', limit: 501 }, { status: 'FAILED', limit: 0 }, { status: 'FAILED', before: 'yesterday' }, { status: 'FAILED', channel: 'PIGEON' }]) {
      expect((await post('/retry', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await request(h.app).post('/api/v1/admin/notifications/retry').send({ status: 'FAILED' })).status).toBe(401);
    expect((await post('/retry', { status: 'FAILED' }, await admin(false))).status).toBe(403);
  });
});

describe('NTF-3 bulk dead-letter replay', () => {
  it('replays across services (and this service) oldest first, reports per-item failures, audits', async () => {
    await writeDeadLetter(h.conn, h.redis, { id: 'n-1', service: 'notifications', stream: 'events.notifications', entryId: '9-0', envelope: { id: 'x' }, error: 'boom', attempts: 5 }, { streamPrefix: h.config.EVENT_STREAM_PREFIX });
    const res = await post('/dead-letters/replay', {});
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(4); // i-1, o-1, i-2 and the local notifications dead letter
    expect(res.body.failed).toEqual([{ service: 'orders', id: 'o-bad', error: 'NOT_FOUND: Dead letter not found' }]);
    expect(replays).toEqual(['identity:i-1', 'orders:o-1', 'identity:i-2']);
    const local = await h.conn.collection('dead_letters').findOne({ _id: 'n-1' as never });
    expect(local!.replayedAt).toBeTruthy();
    const audit = await h.conn.collection('outbox').findOne({ 'envelope.payload.action': 'dead_letter.bulk_replay' });
    expect(audit!.envelope.payload).toMatchObject({ service: 'notifications', targetType: 'dead_letter', targetId: 'all' });
    expect(audit!.envelope.payload.summary).toContain('4 replayed, 1 failed');
  });

  it('honours `service` and `limit`; unreachable service is reported, not hidden', async () => {
    const one = await post('/dead-letters/replay', { service: 'identity', limit: 1 });
    expect(one.body).toEqual({ replayed: 1, failed: [] });
    expect(replays).toEqual(['identity:i-1']);
    ordersDown = true;
    replays.length = 0;
    const down = await post('/dead-letters/replay', { service: 'orders' });
    expect(down.status).toBe(200);
    expect(down.body).toEqual({ replayed: 0, failed: [{ service: 'orders', id: '*', error: expect.stringContaining('UPSTREAM_UNAVAILABLE') }] });
  });

  it('rejects unknown service / bad limit; ADMIN + MFA only', async () => {
    expect((await post('/dead-letters/replay', { service: 'bogus' })).status).toBe(400);
    expect((await post('/dead-letters/replay', { limit: 101 })).status).toBe(400);
    expect((await post('/dead-letters/replay', { limit: 0 })).status).toBe(400);
    expect((await request(h.app).post('/api/v1/admin/notifications/dead-letters/replay').send({})).status).toBe(401);
    expect((await post('/dead-letters/replay', {}, await admin(false))).status).toBe(403);
  });
});

describe('GW-1 provider error messages', () => {
  it('passes the failure description to onProviderError (retryable provider failure and OTP failure)', async () => {
    providerErrors.length = 0;
    const err = Object.assign(new Error('provider down (503)'), { name: 'ProviderSendError' });
    h.sms.failWith = err;
    await h.dispatcher.enqueue({ channel: 'SMS', to: '+919876543210', template: 'order_delivered', data: {}, dedupeKey: `pe:${oid()}` });
    await h.dispatcher.dispatchDue();
    expect(providerErrors).toEqual([{ provider: 'twilio', message: expect.stringContaining('provider down (503)') }]);
    providerErrors.length = 0;
    await expect(h.dispatcher.sendOtp('+919876543210', '123456')).rejects.toThrow();
    expect(providerErrors).toEqual([{ provider: 'twilio', message: expect.stringContaining('provider down (503)') }]);
    expect(providerErrors[0]!.message).not.toContain('123456');
  });
});

describe('IDN-1 ADMIN_PASSWORD_RESET email', () => {
  it('identity can send it; the reset URL is encrypted at rest and delivered in the email', async () => {
    const resetUrl = 'https://thali.test/admin/reset-password?token=tok_123';
    const res = await request(h.app)
      .post('/internal/notifications/send')
      .set('authorization', `Bearer ${await h.serviceToken('identity')}`)
      .send({ channel: 'EMAIL', to: 'Admin@Example.com', template: 'ADMIN_PASSWORD_RESET', data: { resetUrl, expiresMinutes: 30 }, dedupeKey: 'admin-reset:tok-1234' });
    expect(res.status).toBe(202);
    const doc = await h.models.Notification.findById(res.body.notificationId).lean();
    expect(JSON.stringify(doc)).not.toContain('tok_123'); // data + secretEnc: nothing in clear
    expect(doc!.data).toEqual({ expiresMinutes: 30 });
    await h.dispatcher.dispatchById(res.body.notificationId);
    expect(h.email.calls.at(-1)).toMatchObject({ to: 'admin@example.com', subject: 'Reset your Thali admin password' });
    expect(h.email.calls.at(-1)!.text).toContain(resetUrl);
    expect(h.email.calls.at(-1)!.text).toContain('30 minutes');
  });
});
