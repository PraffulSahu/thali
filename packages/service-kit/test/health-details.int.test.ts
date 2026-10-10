import request from 'supertest';
import type { ServiceName } from '@thali/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auditEvent,
  createApp,
  createEnvelope,
  createGoogleGeo,
  createRedis,
  enqueueEvent,
  healthDetails,
  initEventCollections,
  createOpsRouter,
  DEFAULT_OPS_CALLERS,
  outboxModel,
  publishRealtime,
  recordProviderError,
  signServiceToken,
  startConsumer,
  subscribeRealtime,
  withTransaction,
  realtimeChannel,
  type ConsumerHandle,
} from '@thali/service-kit';
import {
  createTestConfig,
  createTestDb,
  createTestRedis,
  testLogger,
  waitFor,
  TEST_INTERNAL_SERVICE_SECRET,
  type TestDb,
  type TestRedis,
} from '@thali/service-kit/testing';

let db: TestDb;
let tr: TestRedis;
const consumers: ConsumerHandle[] = [];

beforeAll(async () => {
  db = await createTestDb('kit_health');
  tr = await createTestRedis();
  await initEventCollections(db.conn);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
});

afterAll(async () => {
  await tr.cleanup();
  await db.drop();
});

const envelope = () =>
  createEnvelope('delivery.job_created', { jobId: 'j', childOrderId: 'c' }, { producer: 'delivery', aggregateId: 'j' });

describe('healthDetails', () => {
  it('measures live values: mongo/redis ping, outbox backlog, consumer lag, dead letters, provider errors', async () => {
    const base = await healthDetails({ conn: db.conn, redis: tr.redis, service: 'delivery', mode: 'demo', streamPrefix: tr.prefix });
    expect(base).toMatchObject({
      service: 'delivery',
      mode: 'demo',
      mongo: 'up',
      redis: 'up',
      outboxPending: 0,
      outboxOldestAgeSec: null,
      consumerLag: {},
      deadLetters: 0,
      providerErrorsLastHour: 0,
    });

    // outbox backlog (no relay running)
    const old = envelope();
    await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, old));
    await outboxModel(db.conn).updateOne({ _id: old.id }, { $set: { createdAt: new Date(Date.now() - 90_000) } });
    await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, envelope()));

    // consumer lag: group exists, 3 entries not yet consumed
    const stream = 'events.orders';
    const c = startConsumer({
      conn: db.conn,
      redis: tr.redis,
      service: 'delivery',
      streams: [stream],
      handlers: {},
      logger: testLogger(),
      streamPrefix: tr.prefix,
    });
    await c.ready;
    await c.stop();
    for (let i = 0; i < 3; i++) await tr.redis.xadd(`${tr.prefix}${stream}`, '*', 'data', JSON.stringify(envelope()));

    await recordProviderError(tr.redis, 'delivery', 'google-routes');
    await recordProviderError(tr.redis, 'delivery', 'google-routes');
    await recordProviderError(tr.redis, 'delivery', 'old', Date.now() - 2 * 3600_000); // outside the window

    const d = await healthDetails({ conn: db.conn, redis: tr.redis, service: 'delivery', mode: 'demo', streams: [stream], streamPrefix: tr.prefix });
    expect(d.outboxPending).toBe(2);
    expect(d.outboxOldestAgeSec).toBeGreaterThanOrEqual(89);
    expect(d.consumerLag).toEqual({ [stream]: 3 });
    expect(d.providerErrorsLastHour).toBe(2);
    expect(d.providerErrorsByProvider).toEqual({ 'google-routes': 2 });
  });

  it('reports redis down without throwing (and mongo still measured)', async () => {
    const dead = createRedis('redis://127.0.0.1:6390', {
      keyPrefix: tr.prefix,
      redisOptions: { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false },
    });
    dead.on('error', () => undefined);
    const d = await healthDetails({ conn: db.conn, redis: dead, service: 'delivery', mode: 'sandbox', streams: ['events.orders'], streamPrefix: tr.prefix });
    expect(d.redis).toBe('down');
    expect(d.mongo).toBe('up');
    expect(d.providerErrorsLastHour).toBeNull();
    expect(d.consumerLag).toEqual({ 'events.orders': null });
    dead.disconnect();
  });

  it('google geo failures are counted through recordProviderError when wired with redis', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    const before = (await healthDetails({ conn: db.conn, redis: tr.redis, service: 'marketplace', mode: 'demo' })).providerErrorsLastHour;
    const geo = createGoogleGeo({ apiKey: 'k', mode: 'demo', redis: tr.redis, service: 'marketplace' });
    await geo.distanceAndEta({ lat: 12.97, lng: 77.6 }, { lat: 12.98, lng: 77.61 });
    const after = (await healthDetails({ conn: db.conn, redis: tr.redis, service: 'marketplace', mode: 'demo' })).providerErrorsLastHour;
    expect(after).toBe((before ?? 0) + 1);
  });
});

describe('ops routes', () => {
  it('serves /internal/health/details and dead-letter routes behind requireInternal', async () => {
    const config = createTestConfig({ SERVICE_NAME: 'delivery', REDIS_KEY_PREFIX: tr.prefix, EVENT_STREAM_PREFIX: tr.prefix });
    const app = createApp({
      config,
      logger: testLogger(),
      routes(a) {
        a.use(createOpsRouter({ conn: db.conn, redis: tr.redis, config, streams: ['events.orders'] }));
      },
    });
    await request(app).get('/internal/health/details').expect(401);
    const token = await signServiceToken('gateway', 'delivery', TEST_INTERNAL_SERVICE_SECRET);
    const res = await request(app).get('/internal/health/details').set('authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ service: 'delivery', mode: 'demo', mongo: 'up', redis: 'up' });
    expect(res.body.consumerLag).toHaveProperty(['events.orders']);

    const list = await request(app).get('/internal/dead-letters').set('authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    await request(app).post('/internal/dead-letters/missing/replay').set('authorization', `Bearer ${token}`).expect(404);
  });

  it('defaults to gateway + notifications callers only; allowed: [] keeps the legacy any-service behaviour', async () => {
    const config = createTestConfig({ SERVICE_NAME: 'delivery', REDIS_KEY_PREFIX: tr.prefix, EVENT_STREAM_PREFIX: tr.prefix });
    const mk = (allowed?: ServiceName[]) =>
      createApp({
        config,
        logger: testLogger(),
        routes(a) {
          a.use(createOpsRouter({ conn: db.conn, redis: tr.redis, config, streams: ['events.orders'], allowed }));
        },
      });
    const tok = (from: ServiceName) => signServiceToken(from, 'delivery', TEST_INTERNAL_SERVICE_SECRET);
    const app = mk();
    expect(DEFAULT_OPS_CALLERS).toEqual(['gateway', 'notifications']);
    // gateway: admin health fan-out
    await request(app).get('/internal/health/details').set('authorization', `Bearer ${await tok('gateway')}`).expect(200);
    // notifications: dead-letter aggregation + replay
    const n = `Bearer ${await tok('notifications')}`;
    await request(app).get('/internal/health/details').set('authorization', n).expect(200);
    await request(app).get('/internal/dead-letters').set('authorization', n).expect(200);
    await request(app).post('/internal/dead-letters/missing/replay').set('authorization', n).expect(404);
    // any other service is refused
    const o = `Bearer ${await tok('orders')}`;
    const denied = await request(app).get('/internal/dead-letters').set('authorization', o).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    await request(app).post('/internal/dead-letters/missing/replay').set('authorization', o).expect(403);
    await request(app).get('/internal/health/details').set('authorization', o).expect(403);
    // explicit opt-outs
    await request(mk([])).get('/internal/health/details').set('authorization', o).expect(200);
    await request(mk(['orders'])).get('/internal/health/details').set('authorization', `Bearer ${await tok('gateway')}`).expect(403);
  });
});

describe('auditEvent', () => {
  it('enqueues audit.recorded on events.<service> in the caller transaction', async () => {
    const e = await withTransaction(db.conn, (s) =>
      auditEvent(db.conn, s, {
        service: 'marketplace',
        actorId: 'admin1',
        actorRole: 'ADMIN',
        action: 'restaurant.approve',
        targetType: 'restaurant',
        targetId: 'r1',
        summary: 'Approved restaurant r1',
        ip: '10.0.0.1',
        correlationId: 'req-1',
      }),
    );
    const row = await outboxModel(db.conn).findById(e.id).lean();
    expect(row?.stream).toBe('events.marketplace');
    expect(row?.envelope).toMatchObject({
      type: 'audit.recorded',
      producer: 'marketplace',
      correlationId: 'req-1',
      aggregateId: 'r1',
      payload: { actorId: 'admin1', action: 'restaurant.approve', service: 'marketplace', ip: '10.0.0.1' },
    });
  });
});

describe('realtime pub/sub', () => {
  it('publishRealtime -> PUBLISH <prefix>rt:<channel> {event,data}; subscribeRealtime receives unprefixed channel', async () => {
    const got: { channel: string; event: string; data: unknown }[] = [];
    const sub = await subscribeRealtime(tr.redis, ['user:*', 'admin'], (channel, msg) => got.push({ channel, ...msg }));
    const receivers = await publishRealtime(tr.redis, realtimeChannel.user('u1'), 'order.updated', { childOrderId: 'c1', status: 'ACCEPTED' });
    expect(receivers).toBe(1);
    await publishRealtime(tr.redis, realtimeChannel.admin(), 'notification', { id: 'n', title: 't', body: 'b' });
    await publishRealtime(tr.redis, realtimeChannel.partner('p1'), 'partner.offer', { offerId: 'o' }); // not subscribed
    await waitFor(() => got.length >= 2, { timeoutMs: 2000 });
    await sub.close();
    expect(got).toEqual([
      { channel: 'user:u1', event: 'order.updated', data: { childOrderId: 'c1', status: 'ACCEPTED' } },
      { channel: 'admin', event: 'notification', data: { id: 'n', title: 't', body: 'b' } },
    ]);
    expect(realtimeChannel.owner('o1')).toBe('owner:o1');
  });
});
