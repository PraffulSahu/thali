import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@thali/contracts';
import {
  createEnvelope,
  currentRequestId,
  inboxModel,
  initEventCollections,
  startConsumer,
  type ConsumerHandle,
  type EventHandlers,
  type StartConsumerOptions,
} from '@thali/service-kit';
import { createTestDb, createTestRedis, testLogger, waitFor, type TestDb, type TestRedis } from '@thali/service-kit/testing';

let db: TestDb;
let tr: TestRedis;
const consumers: ConsumerHandle[] = [];
let n = 0;

beforeAll(async () => {
  db = await createTestDb('kit_consumer');
  tr = await createTestRedis();
  await initEventCollections(db.conn);
  await db.conn.createCollection('effects');
  await db.conn.createCollection('things');
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
});

afterAll(async () => {
  await tr.cleanup();
  await db.drop();
});

/** Fresh stream per test so tests never see each other's entries. */
function newStream(): string {
  n += 1;
  return `events.c${n}`;
}

function env(id = 'x'): EventEnvelope<'payment.captured'> {
  return createEnvelope(
    'payment.captured',
    { paymentIntentId: `pi_${id}`, purpose: 'CHECKOUT', referenceId: 'co1', userId: 'u1', amountPaise: 1000, providerPaymentId: 'pay_1' },
    { producer: 'payments', correlationId: `corr-${id}`, aggregateId: `pi_${id}` },
  );
}

async function publish(stream: string, e: unknown): Promise<void> {
  await tr.redis.xadd(`${tr.prefix}${stream}`, '*', 'data', typeof e === 'string' ? e : JSON.stringify(e));
}

function consume(stream: string, handlers: EventHandlers, extra: Partial<StartConsumerOptions> = {}): ConsumerHandle {
  const c = startConsumer({
    conn: db.conn,
    redis: tr.redis,
    service: 'orders',
    streams: [stream],
    handlers,
    logger: testLogger(),
    streamPrefix: tr.prefix,
    claimIdleMs: 200,
    backoffBaseMs: 20,
    blockMs: 100,
    ...extra,
  });
  consumers.push(c);
  return c;
}

async function bump(key: string, session: Parameters<NonNullable<EventHandlers['payment.captured']>>[1]) {
  await db.conn.collection('effects').updateOne({ _id: key as never }, { $inc: { n: 1 } }, { upsert: true, session });
}
async function effect(key: string): Promise<number> {
  const doc = await db.conn.collection('effects').findOne({ _id: key as never });
  return (doc?.n as number | undefined) ?? 0;
}

async function settled(stream: string): Promise<boolean> {
  const groups = (await tr.redis.xinfo('GROUPS', `${tr.prefix}${stream}`)) as unknown[][];
  const g = groups.map((row) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < row.length; i += 2) o[String(row[i])] = row[i + 1];
    return o;
  })[0];
  return !!g && Number(g.pending) === 0 && Number(g.lag) === 0;
}

describe('startConsumer', () => {
  it('creates the consumer group cg.<service> on the prefixed stream (MKSTREAM)', async () => {
    const s = newStream();
    const c = consume(s, {});
    await c.ready;
    const groups = (await tr.redis.xinfo('GROUPS', `${tr.prefix}${s}`)) as unknown[][];
    expect(groups[0]).toContain('cg.orders');
  });

  it('runs the handler once for an event delivered twice (inbox dedupe)', async () => {
    const s = newStream();
    const e = env('dup');
    let calls = 0;
    consume(s, {
      'payment.captured': async (_e, session) => {
        calls += 1;
        await bump('dup', session);
      },
    });
    await publish(s, e);
    await publish(s, e);
    await waitFor(() => settled(s), { timeoutMs: 5000 });
    expect(await effect('dup')).toBe(1);
    expect(calls).toBe(1);
    const inbox = await inboxModel(db.conn).findById(e.id).lean();
    expect(inbox).toMatchObject({ _id: e.id, type: 'payment.captured', attempts: 1 });
    expect(inbox?.processedAt).toBeInstanceOf(Date);
  });

  it('dedupes concurrent deliveries across two consumers of the same group', async () => {
    const s = newStream();
    const handlers: EventHandlers = {
      'payment.captured': async (e, session) => {
        await bump(`conc-${e.id}`, session);
      },
    };
    consume(s, handlers);
    consume(s, handlers);
    const events = Array.from({ length: 10 }, (_, i) => env(`conc${i}`));
    for (const e of events) {
      await publish(s, e);
      await publish(s, e);
    }
    await waitFor(() => settled(s), { timeoutMs: 8000 });
    for (const e of events) expect(await effect(`conc-${e.id}`)).toBe(1);
  });

  it('retries a failing handler with backoff and processes it once; attempts recorded', async () => {
    const s = newStream();
    const e = env('retry');
    const callTimes: number[] = [];
    consume(s, {
      'payment.captured': async (_e, session) => {
        callTimes.push(Date.now());
        await bump('retry', session);
        if (callTimes.length <= 2) throw new Error(`transient ${callTimes.length}`);
      },
    });
    await publish(s, e);
    await waitFor(async () => (await inboxModel(db.conn).findById(e.id).lean()) != null, { timeoutMs: 5000 });
    await waitFor(() => settled(s), { timeoutMs: 2000 });
    expect(callTimes).toHaveLength(3);
    // failed attempts were rolled back with the transaction; only the successful one persisted
    expect(await effect('retry')).toBe(1);
    expect((await inboxModel(db.conn).findById(e.id).lean())?.attempts).toBe(3);
    // backoff min(2^attempt * base): >= 40 ms after the 1st failure, >= 80 ms after the 2nd
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(40);
    expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(80);
  });

  it("treats a duplicate-key error from the handler's own writes as a failure, not a duplicate event", async () => {
    const s = newStream();
    const e = env('ownkey');
    await db.conn.collection('things').insertOne({ _id: 'taken' as never });
    let calls = 0;
    consume(s, {
      'payment.captured': async (_e, session) => {
        calls += 1;
        await db.conn.collection('things').insertOne({ _id: 'taken' as never }, { session });
      },
    });
    await publish(s, e);
    await waitFor(() => calls >= 1, { timeoutMs: 3000 });
    await db.conn.collection('things').deleteOne({ _id: 'taken' as never });
    await waitFor(async () => (await inboxModel(db.conn).findById(e.id).lean()) != null, { timeoutMs: 5000 });
    expect(calls).toBe(2);
  });

  it('acks and ignores unknown event types (no inbox row)', async () => {
    const s = newStream();
    const e = { ...env('unknown'), type: 'something.else' };
    let calls = 0;
    consume(s, { 'payment.captured': async () => void (calls += 1) });
    await publish(s, e);
    await waitFor(() => settled(s), { timeoutMs: 3000 });
    expect(calls).toBe(0);
    expect(await inboxModel(db.conn).countDocuments({ _id: e.id })).toBe(0);
  });

  it('binds the envelope correlationId as the request id inside handlers', async () => {
    const s = newStream();
    const e = env('corr');
    let seen: string | undefined;
    consume(s, { 'payment.captured': async () => void (seen = currentRequestId()) });
    await publish(s, e);
    await waitFor(() => seen !== undefined, { timeoutMs: 3000 });
    expect(seen).toBe('corr-corr');
  });

  it('reclaims entries left pending by a crashed consumer after claimIdleMs', async () => {
    const s = newStream();
    const key = `${tr.prefix}${s}`;
    const e = env('crash');
    await tr.redis.xgroup('CREATE', key, 'cg.orders', '0', 'MKSTREAM');
    await publish(s, e);
    // a consumer that read the entry and died without acking
    await tr.redis.xreadgroup('GROUP', 'cg.orders', 'dead-consumer', 'COUNT', 10, 'STREAMS', key, '>');
    consume(s, { 'payment.captured': async (_e, session) => bump('crash', session) });
    await waitFor(async () => (await inboxModel(db.conn).findById(e.id).lean()) != null, { timeoutMs: 5000 });
    expect((await inboxModel(db.conn).findById(e.id).lean())?.attempts).toBe(2);
    expect(await effect('crash')).toBe(1);
  });

  it('stop() stops reading and waits for the in-flight handler', async () => {
    const s = newStream();
    const e = env('stop');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const c = consume(s, {
      'payment.captured': async (_e, session) => {
        started = true;
        await gate;
        await bump('stop', session);
      },
    });
    await publish(s, e);
    await waitFor(() => started, { timeoutMs: 3000 });
    let stopped = false;
    const stopping = c.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await inboxModel(db.conn).countDocuments({ _id: e.id })).toBe(1);
    expect(await effect('stop')).toBe(1);

    // after stop nothing more is consumed
    const later = env('after-stop');
    await publish(s, later);
    await new Promise((r) => setTimeout(r, 300));
    expect(await inboxModel(db.conn).countDocuments({ _id: later.id })).toBe(0);
  });
});
