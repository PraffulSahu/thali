import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@thali/contracts';
import {
  createEnvelope,
  deadLetterModel,
  inboxModel,
  initEventCollections,
  listDeadLetters,
  replayDeadLetter,
  startConsumer,
  type ConsumerHandle,
  type EventHandlers,
} from '@thali/service-kit';
import { createTestDb, createTestRedis, testLogger, waitFor, type TestDb, type TestRedis } from '@thali/service-kit/testing';

let db: TestDb;
let tr: TestRedis;
const consumers: ConsumerHandle[] = [];

beforeAll(async () => {
  db = await createTestDb('kit_dlq');
  tr = await createTestRedis();
  await initEventCollections(db.conn);
  await db.conn.createCollection('effects');
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
});

afterAll(async () => {
  await tr.cleanup();
  await db.drop();
});

function env(id: string): EventEnvelope<'order.rejected'> {
  return createEnvelope(
    'order.rejected',
    { childOrderId: id, checkoutId: 'co', userId: 'u', restaurantId: 'r', reason: 'out of stock', refundPaise: 500 },
    { producer: 'orders', correlationId: `corr-${id}`, aggregateId: id },
  );
}

function consume(stream: string, handlers: EventHandlers): ConsumerHandle {
  const c = startConsumer({
    conn: db.conn,
    redis: tr.redis,
    service: 'payments',
    streams: [stream],
    handlers,
    logger: testLogger(),
    streamPrefix: tr.prefix,
    maxAttempts: 3,
    claimIdleMs: 200,
    backoffBaseMs: 10,
    blockMs: 100,
  });
  consumers.push(c);
  return c;
}

async function pending(stream: string): Promise<number> {
  const [count] = (await tr.redis.xpending(`${tr.prefix}${stream}`, 'cg.payments')) as [number];
  return Number(count);
}

describe('dead letters', () => {
  it('moves an always-failing event to dead_letters + dlq.<service> after maxAttempts and acks it; replay reprocesses', async () => {
    const stream = 'events.orders';
    const e = env('poison');
    let calls = 0;
    let fixed = false;
    consume(stream, {
      'order.rejected': async (_e, session) => {
        calls += 1;
        if (!fixed) throw new Error('refund provider exploded');
        await db.conn.collection('effects').updateOne({ _id: 'refund' as never }, { $inc: { n: 1 } }, { upsert: true, session });
      },
    });
    await tr.redis.xadd(`${tr.prefix}${stream}`, '*', 'data', JSON.stringify(e));

    await waitFor(async () => (await deadLetterModel(db.conn).findById(e.id).lean()) != null, { timeoutMs: 8000 });
    const dl = await deadLetterModel(db.conn).findById(e.id).lean();
    expect(dl).toMatchObject({ _id: e.id, stream, attempts: 3, error: 'refund provider exploded', replayedAt: null });
    expect(dl?.envelope).toEqual(e);
    expect(dl?.failedAt).toBeInstanceOf(Date);
    expect(calls).toBe(3);
    await waitFor(async () => (await pending(stream)) === 0, { timeoutMs: 2000 });

    const dlq = await tr.redis.xrange(`${tr.prefix}dlq.payments`, '-', '+');
    expect(dlq).toHaveLength(1);
    const fields = dlq[0]![1];
    expect(JSON.parse(fields[fields.indexOf('data') + 1]!)).toEqual(e);
    expect(fields[fields.indexOf('stream') + 1]).toBe(stream);

    const listed = await listDeadLetters(db.conn);
    expect(listed.map((d) => d._id)).toContain(e.id);
    expect(await inboxModel(db.conn).countDocuments({ _id: e.id })).toBe(0);

    // fix the handler and replay
    fixed = true;
    const before = await tr.redis.xlen(`${tr.prefix}${stream}`);
    const replayed = await replayDeadLetter(db.conn, tr.redis, e.id, { streamPrefix: tr.prefix });
    expect(replayed.entryId).toMatch(/^\d+-\d+$/);
    expect(await tr.redis.xlen(`${tr.prefix}${stream}`)).toBe(before + 1);
    await waitFor(async () => (await inboxModel(db.conn).findById(e.id).lean()) != null, { timeoutMs: 5000 });
    const doc = await db.conn.collection('effects').findOne({ _id: 'refund' as never });
    expect(doc?.n).toBe(1);
    expect((await deadLetterModel(db.conn).findById(e.id).lean())?.replayedAt).toBeInstanceOf(Date);
    expect(await listDeadLetters(db.conn, { includeReplayed: false })).not.toContainEqual(expect.objectContaining({ _id: e.id }));

    // replaying again is harmless: the inbox dedupes
    await replayDeadLetter(db.conn, tr.redis, e.id, { streamPrefix: tr.prefix });
    await waitFor(async () => (await pending(stream)) === 0, { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await db.conn.collection('effects').findOne({ _id: 'refund' as never }))?.n).toBe(1);
  });

  it('dead-letters malformed stream entries immediately', async () => {
    const stream = 'events.malformed';
    consume(stream, { 'order.rejected': async () => undefined });
    const id = await tr.redis.xadd(`${tr.prefix}${stream}`, '*', 'data', '{not json');
    await waitFor(async () => (await deadLetterModel(db.conn).countDocuments({ entryId: id })) === 1, { timeoutMs: 5000 });
    const dl = await deadLetterModel(db.conn).findOne({ entryId: id }).lean();
    expect(dl?._id).toBe(`${stream}:${id}`);
    expect(dl?.error).toMatch(/malformed/i);
    await waitFor(async () => (await pending(stream)) === 0, { timeoutMs: 2000 });
  });

  it('replayDeadLetter rejects unknown ids', async () => {
    await expect(replayDeadLetter(db.conn, tr.redis, 'nope', { streamPrefix: tr.prefix })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
