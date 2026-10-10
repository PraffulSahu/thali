import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import type { ServiceName } from '@thali/contracts';
import { createEnvelope, startConsumer, startRelay, type ConsumerHandle, type RelayHandle } from '@thali/service-kit';
import { testLogger, waitFor } from '@thali/service-kit/testing';
import { AUDIT_STREAMS, identityEventHandlers } from '../src/events/handlers.js';
import { bearer, createHarness, isRevoked, loginWithOtp, mintToken, randomPhone, withCsrf, type Harness } from './helpers.js';

let h: Harness;
let consumer: ConsumerHandle;
let relay: RelayHandle;
let adminToken: string;
const adminId = new Types.ObjectId().toHexString();

beforeAll(async () => {
  h = await createHarness('audit');
  const logger = testLogger('identity');
  consumer = startConsumer({
    conn: h.db.conn,
    redis: h.tr.redis,
    logger,
    service: 'identity',
    streamPrefix: h.config.EVENT_STREAM_PREFIX,
    streams: AUDIT_STREAMS,
    handlers: identityEventHandlers(h.db.conn),
    blockMs: 100,
    claimIdleMs: 300,
    backoffBaseMs: 20,
  });
  await consumer.ready;
  relay = startRelay({ conn: h.db.conn, redis: h.tr.redis, logger, service: 'identity', streamPrefix: h.config.EVENT_STREAM_PREFIX, intervalMs: 100 });
  adminToken = await mintToken(h, { userId: adminId, roles: ['CONSUMER', 'ADMIN'], adminRoles: ['SUPPORT'], amr: ['pwd', 'mfa'] });
});
afterAll(async () => {
  await consumer?.stop();
  await relay?.stop();
  await h?.close();
});

const logs = () => h.db.conn.collection('audit_logs');

async function publishAudit(service: ServiceName, payload: { action: string; targetType: string; targetId: string }, times = 1) {
  const env = createEnvelope(
    'audit.recorded',
    { actorId: adminId, actorRole: 'ADMIN', summary: `${payload.action} ${payload.targetId}`, ip: '10.0.0.1', service, ...payload },
    { producer: service, aggregateId: payload.targetId },
  );
  for (let i = 0; i < times; i++) {
    await h.tr.redis.xadd(`${h.config.EVENT_STREAM_PREFIX}events.${service}`, '*', 'data', JSON.stringify(env));
  }
  return env;
}

describe('audit.recorded consumer', () => {
  it('consumes from all six service streams', () => {
    expect([...AUDIT_STREAMS].sort()).toEqual(
      ['events.delivery', 'events.identity', 'events.marketplace', 'events.notifications', 'events.orders', 'events.payments'].sort(),
    );
  });

  it('stores an event once even if delivered twice', async () => {
    const env = await publishAudit('marketplace', { action: 'restaurant.approve', targetType: 'restaurant', targetId: 'r-dup' }, 2);
    await waitFor(async () => (await logs().countDocuments({ eventId: env.id })) === 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(await logs().countDocuments({ eventId: env.id })).toBe(1);
    const doc = await logs().findOne({ eventId: env.id });
    expect(doc).toMatchObject({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'restaurant.approve',
      targetType: 'restaurant',
      targetId: 'r-dup',
      service: 'marketplace',
      ip: '10.0.0.1',
      correlationId: env.correlationId,
    });
    expect(new Date(doc!.occurredAt).toISOString()).toBe(env.occurredAt);
  });

  it('consumes events.notifications too', async () => {
    const env = await publishAudit('notifications', { action: 'notification.retry', targetType: 'notification', targetId: 'n1' });
    await waitFor(async () => (await logs().countDocuments({ eventId: env.id })) === 1);
  });
});

describe('GET /admin/audit-logs', () => {
  it('filters by targetType and paginates; admin + MFA only', async () => {
    for (const id of ['r-a', 'r-b', 'r-c']) {
      await publishAudit('marketplace', { action: 'restaurant.suspend', targetType: 'restaurant', targetId: id });
    }
    await publishAudit('orders', { action: 'order.cancel', targetType: 'order', targetId: 'o-1' });
    await waitFor(async () => (await logs().countDocuments({ targetType: 'restaurant' })) >= 4 && (await logs().countDocuments({ targetType: 'order' })) === 1);
    const total = await logs().countDocuments({ targetType: 'restaurant' });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: Record<string, string> = { targetType: 'restaurant', limit: '2', ...(cursor ? { cursor } : {}) };
      const r = await request(h.app).get('/api/v1/admin/audit-logs').query(q).set(bearer(adminToken));
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      for (const it of r.body.items) {
        expect(it.targetType).toBe('restaurant');
        seen.push(it.id);
      }
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 2));

    const first = await request(h.app).get('/api/v1/admin/audit-logs').query({ targetType: 'restaurant' }).set(bearer(adminToken));
    const times = first.body.items.map((x: { occurredAt: string }) => Date.parse(x.occurredAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);

    const pwdOnly = await mintToken(h, { userId: adminId, roles: ['CONSUMER', 'ADMIN'], adminRoles: ['SUPPORT'], amr: ['pwd'] });
    const denied = await request(h.app).get('/api/v1/admin/audit-logs').set(bearer(pwdOnly));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('MFA_REQUIRED');
    const consumerTok = await mintToken(h, { userId: adminId, roles: ['CONSUMER'], amr: ['otp'] });
    expect((await request(h.app).get('/api/v1/admin/audit-logs').set(bearer(consumerTok))).status).toBe(403);
    expect((await request(h.app).get('/api/v1/admin/audit-logs')).status).toBe(401);
  });
});

describe('admin users', () => {
  it('block emits audit, revokes sessions; unblock restores', async () => {
    const phone = randomPhone();
    const u = await loginWithOtp(h.app, h, phone);

    const found = await request(h.app).get('/api/v1/admin/users').query({ q: phone.slice(-6) }).set(bearer(adminToken));
    expect(found.status).toBe(200);
    expect(found.body.items.map((x: { id: string }) => x.id)).toContain(u.userId);
    const one = await request(h.app).get(`/api/v1/admin/users/${u.userId}`).set(bearer(adminToken));
    expect(one.status).toBe(200);
    expect(one.body.phone).toBe(phone);

    const b = await request(h.app).post(`/api/v1/admin/users/${u.userId}/block`).set(bearer(adminToken)).send({ reason: 'fraud' });
    expect(b.status).toBe(200);
    expect(b.body.status).toBe('BLOCKED');
    expect(await isRevoked(h, u.sid)).toBe(true);
    expect((await request(h.app).get('/api/v1/me').set(bearer(u.accessToken))).status).toBe(401);
    const rf = await withCsrf(request(h.app).post('/api/v1/auth/refresh')).set('Cookie', u.cookie);
    expect(rf.status).toBe(401);

    const blockAudit = await h.db.conn
      .collection('outbox')
      .findOne({ 'envelope.type': 'audit.recorded', 'envelope.payload.action': 'user.block', 'envelope.payload.targetId': u.userId });
    expect(blockAudit).not.toBeNull();
    expect(blockAudit!.envelope.payload).toMatchObject({ actorId: adminId, targetType: 'user', service: 'identity' });
    // relay → events.identity → consumer → audit_logs
    await waitFor(async () => (await logs().countDocuments({ action: 'user.block', targetId: u.userId })) === 1);

    const ub = await request(h.app).post(`/api/v1/admin/users/${u.userId}/unblock`).set(bearer(adminToken)).send({});
    expect(ub.status).toBe(200);
    expect(ub.body.status).toBe('ACTIVE');
    const unblockAudit = await h.db.conn
      .collection('outbox')
      .findOne({ 'envelope.type': 'audit.recorded', 'envelope.payload.action': 'user.unblock', 'envelope.payload.targetId': u.userId });
    expect(unblockAudit).not.toBeNull();
    // can log in again
    await loginWithOtp(h.appWith({ OTP_RESEND_COOLDOWN_SEC: '0' }), h, phone);
  });

  it('admin cannot block themselves; unknown user → 404; consumer → 403', async () => {
    const self = await request(h.app).post(`/api/v1/admin/users/${adminId}/block`).set(bearer(adminToken)).send({ reason: 'x' });
    expect(self.status).toBe(409);
    const unknown = await request(h.app).post(`/api/v1/admin/users/${new Types.ObjectId().toHexString()}/block`).set(bearer(adminToken)).send({ reason: 'x' });
    expect(unknown.status).toBe(404);
    const consumerTok = await mintToken(h, { userId: adminId, roles: ['CONSUMER'] });
    expect((await request(h.app).get('/api/v1/admin/users').set(bearer(consumerTok))).status).toBe(403);
  });
});
