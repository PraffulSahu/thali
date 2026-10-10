import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@thali/contracts';
import {
  createEnvelope,
  enqueueEvent,
  initEventCollections,
  outboxModel,
  runWithRequestId,
  startRelay,
  withTransaction,
  type RelayHandle,
} from '@thali/service-kit';
import { createTestDb, createTestRedis, testLogger, waitFor, type TestDb, type TestRedis } from '@thali/service-kit/testing';

let db: TestDb;
let tr: TestRedis;
const relays: RelayHandle[] = [];

beforeAll(async () => {
  db = await createTestDb('kit_outbox');
  tr = await createTestRedis();
  await initEventCollections(db.conn);
});

afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

afterAll(async () => {
  await tr.cleanup();
  await db.drop();
});

function placed(aggregateId = 'child1'): EventEnvelope<'order.placed'> {
  return createEnvelope(
    'order.placed',
    {
      childOrderId: aggregateId,
      checkoutId: 'co1',
      userId: 'u1',
      restaurantId: 'r1',
      restaurantOwnerId: 'o1',
      code: 'A1B2',
      totalPaise: 12_300,
      acceptBy: new Date().toISOString(),
    },
    { producer: 'orders', correlationId: 'corr-1', aggregateId },
  );
}

async function streamIds(stream: string): Promise<string[]> {
  const entries = await tr.redis.xrange(`${tr.prefix}${stream}`, '-', '+');
  return entries.map(([, fields]) => (JSON.parse(fields[1]!) as EventEnvelope).id);
}

function relay(intervalMs = 50): RelayHandle {
  const r = startRelay({ conn: db.conn, redis: tr.redis, logger: testLogger(), service: 'orders', streamPrefix: tr.prefix, intervalMs });
  relays.push(r);
  return r;
}

describe('createEnvelope', () => {
  it('builds an LLD 1.6 envelope with a uuid id', () => {
    const e = placed('c9');
    expect(e).toMatchObject({ type: 'order.placed', version: 1, producer: 'orders', correlationId: 'corr-1', aggregateId: 'c9' });
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(e.occurredAt).toISOString()).toBe(e.occurredAt);
    expect(placed().id).not.toBe(e.id);
  });

  it('defaults correlationId to the current request id', () => {
    const e = runWithRequestId('req-77', () =>
      createEnvelope('role.granted', { userId: 'u', role: 'CONSUMER' }, { producer: 'identity', aggregateId: 'u' }),
    );
    expect(e.correlationId).toBe('req-77');
  });
});

describe('outbox + relay', () => {
  it('requires a session (the outbox row must share the business transaction)', async () => {
    await expect(enqueueEvent(db.conn, undefined as never, placed())).rejects.toThrow(/session/);
  });

  it('publishes an event enqueued in a committed transaction within 2 s and marks publishedAt', async () => {
    relay();
    const e = placed('commit');
    await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, e));

    const row = await outboxModel(db.conn).findById(e.id).lean();
    expect(row).toMatchObject({ _id: e.id, stream: 'events.orders', attempts: 0 });

    await waitFor(async () => (await streamIds('events.orders')).includes(e.id), { timeoutMs: 2000 });
    const entries = await tr.redis.xrange(`${tr.prefix}events.orders`, '-', '+');
    const published = entries.map(([, f]) => JSON.parse(f[1]!) as EventEnvelope).find((x) => x.id === e.id);
    expect(published).toEqual(e);
    expect(entries[0]![1][0]).toBe('data');

    await waitFor(async () => (await outboxModel(db.conn).findById(e.id).lean())?.publishedAt != null, { timeoutMs: 2000 });
  });

  it('publishes nothing for an aborted transaction', async () => {
    relay();
    const e = placed('abort');
    await expect(
      withTransaction(db.conn, async (s) => {
        await enqueueEvent(db.conn, s, e);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await outboxModel(db.conn).countDocuments({ _id: e.id })).toBe(0);
    // give the relay several cycles to (not) publish
    const marker = placed('marker');
    await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, marker));
    await waitFor(async () => (await streamIds('events.orders')).includes(marker.id), { timeoutMs: 2000 });
    expect(await streamIds('events.orders')).not.toContain(e.id);
  });

  it('honours an explicit stream name', async () => {
    relay();
    const e = createEnvelope(
      'audit.recorded',
      { actorId: 'a', actorRole: 'ADMIN', action: 'x', targetType: 't', targetId: '1', summary: 's', service: 'notifications' },
      { producer: 'notifications', aggregateId: '1' },
    );
    await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, e, 'events.notifications'));
    await waitFor(async () => (await streamIds('events.notifications')).includes(e.id), { timeoutMs: 2000 });
  });

  it('with two relays running, each event is published exactly once (leader lock relay:<service>)', async () => {
    const a = relay(40);
    const b = relay(40);
    const events = Array.from({ length: 30 }, (_, i) => placed(`dup-${i}`));
    for (const e of events) await withTransaction(db.conn, (s) => enqueueEvent(db.conn, s, e));

    await waitFor(async () => (await outboxModel(db.conn).countDocuments({ _id: { $in: events.map((e) => e.id) }, publishedAt: null })) === 0, {
      timeoutMs: 5000,
    });
    // let both relays cycle a few more times
    await new Promise((r) => setTimeout(r, 200));
    const ids = await streamIds('events.orders');
    for (const e of events) expect(ids.filter((id) => id === e.id)).toHaveLength(1);

    const holder = await tr.redis.get(`${tr.prefix}lock:relay:orders`);
    expect([a.instanceId, b.instanceId]).toContain(holder);
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
  });

  it('releases the relay lock on stop', async () => {
    const r = relay(40);
    await waitFor(() => r.isLeader(), { timeoutMs: 2000 });
    await r.stop();
    expect(await tr.redis.get(`${tr.prefix}lock:relay:orders`)).toBeNull();
  });
});
