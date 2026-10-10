import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Schema } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, idempotency } from '@thali/service-kit';
import { createTestConfig, createTestDb, testLogger, type TestDb } from '@thali/service-kit/testing';

let db: TestDb;
let app: ReturnType<typeof createApp>;
const calls: Record<string, number> = { create: 0, fail: 0, slow: 0, optional: 0, abort: 0, takeover: 0, shapes: 0 };
let server: Server;
let baseUrl: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createTestDb('kit_idem');
  app = createApp({
    config: createTestConfig(),
    logger: testLogger(),
    routes(a) {
      // simulate requireAuth: user from header
      a.use((req, _res, next) => {
        const u = req.header('x-user');
        if (u) req.auth = { userId: u, roles: ['CONSUMER'], sessionId: 's', amr: ['otp'], adminRoles: [] };
        next();
      });
      const idem = idempotency({ scope: 'checkout', conn: db.conn });
      a.post('/create', idem, (req, res) => {
        calls.create! += 1;
        res.status(201).json({ n: calls.create, body: req.body });
      });
      a.post('/fail', idempotency({ scope: 'fail', conn: db.conn }), (_req, res) => {
        calls.fail! += 1;
        if (calls.fail === 1) throw new Error('db exploded');
        res.status(201).json({ n: calls.fail });
      });
      a.post('/slow', idempotency({ scope: 'slow', conn: db.conn }), async (_req, res) => {
        calls.slow! += 1;
        await new Promise((r) => setTimeout(r, 300));
        res.status(201).json({ n: calls.slow });
      });
      a.post('/abortable', idempotency({ scope: 'abort', conn: db.conn }), async (_req, res) => {
        calls.abort! += 1;
        await sleep(400);
        res.status(201).json({ n: calls.abort });
      });
      a.post('/takeover', idempotency({ scope: 'takeover', conn: db.conn, lockTimeoutSec: 0.2 }), async (_req, res) => {
        calls.takeover! += 1;
        const n = calls.takeover;
        if (n === 1) await sleep(700);
        res.status(201).json({ n });
      });
      const Thing = db.conn.model('Thing', new Schema({ name: String, tags: [String], at: Date }), 'things');
      a.post('/shapes', idempotency({ scope: 'shapes', conn: db.conn }), async (req, res) => {
        calls.shapes! += 1;
        if (req.body.kind === 'doc') {
          const doc = await Thing.create({ name: 'paneer', tags: ['veg'], at: new Date('2026-10-10T00:00:00Z') });
          res.status(201).json(doc);
        } else if (req.body.kind === 'null') {
          res.status(200).json(null);
        } else {
          res.status(201).json({ a: 1, u: undefined, nested: { v: undefined, d: new Date(0), arr: [undefined, 1] } });
        }
      });
      a.post('/optional', idempotency({ scope: 'opt', conn: db.conn, required: false }), (_req, res) => {
        calls.optional! += 1;
        res.json({ n: calls.optional });
      });
    },
  });
});

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.drop();
});

describe('idempotency middleware (LLD 1.4)', () => {
  it('same key + body twice → handler called once, identical status/body', async () => {
    const first = await request(app).post('/create').set('Idempotency-Key', 'key-same-0001').set('x-user', 'u1').send({ a: 1, b: [1, 2] });
    const second = await request(app).post('/create').set('Idempotency-Key', 'key-same-0001').set('x-user', 'u1').send({ b: [1, 2], a: 1 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls.create).toBe(1);

    const doc = await db.conn.collection('idempotency_keys').findOne({ _id: 'checkout:u1:key-same-0001' as never });
    expect(doc).toMatchObject({ status: 'COMPLETED', responseStatus: 201, responseBody: JSON.stringify(first.body) });
    expect(doc!.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc!.createdAt).toBeInstanceOf(Date);
  });

  it('has a 24 h TTL index on createdAt', async () => {
    await db.conn.model('IdempotencyKey').init();
    const idx = await db.conn.collection('idempotency_keys').indexes();
    expect(idx).toEqual(expect.arrayContaining([expect.objectContaining({ key: { createdAt: 1 }, expireAfterSeconds: 86400 })]));
  });

  it('same key, different body → 409 IDEMPOTENCY_CONFLICT', async () => {
    await request(app).post('/create').set('Idempotency-Key', 'key-diff-0001').set('x-user', 'u1').send({ a: 1 });
    const res = await request(app).post('/create').set('Idempotency-Key', 'key-diff-0001').set('x-user', 'u1').send({ a: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('keys are scoped per user (anon users share the anon scope)', async () => {
    const before = calls.create!;
    await request(app).post('/create').set('Idempotency-Key', 'key-user-0001').set('x-user', 'uA').send({});
    await request(app).post('/create').set('Idempotency-Key', 'key-user-0001').set('x-user', 'uB').send({});
    await request(app).post('/create').set('Idempotency-Key', 'key-user-0001').send({});
    expect(calls.create! - before).toBe(3);
    const ids = (await db.conn.collection('idempotency_keys').find({ _id: { $regex: 'key-user-0001$' } as never }).toArray()).map((d) => d._id);
    expect(ids.sort()).toEqual(['checkout:anon:key-user-0001', 'checkout:uA:key-user-0001', 'checkout:uB:key-user-0001']);
  });

  it('concurrent same key → one 201, the other 409 IDEMPOTENCY_IN_PROGRESS or a replay', async () => {
    const send = () => request(app).post('/slow').set('Idempotency-Key', 'key-race-0001').set('x-user', 'u1').send({ x: 1 });
    const [a, b] = await Promise.all([send(), send()]);
    const results = [a, b].map((r) => `${r.status}:${r.body.error?.code ?? r.body.n}`).sort();
    expect(calls.slow).toBe(1);
    expect(results[0]).toBe('201:1');
    expect(['201:1', '409:IDEMPOTENCY_IN_PROGRESS']).toContain(results[1]);
  });

  it('missing header on a required route → 400 IDEMPOTENCY_KEY_REQUIRED; malformed → 400 VALIDATION_FAILED', async () => {
    const res = await request(app).post('/create').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await request(app).post('/create').set('Idempotency-Key', 'bad key!').send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('optional routes run without a key', async () => {
    const res = await request(app).post('/optional').send({});
    expect(res.status).toBe(200);
  });

  it('failed handler (5xx) releases the key so a retry runs again', async () => {
    const first = await request(app).post('/fail').set('Idempotency-Key', 'key-fail-0001').send({ a: 1 });
    expect(first.status).toBe(500);
    const retry = await request(app).post('/fail').set('Idempotency-Key', 'key-fail-0001').send({ a: 1 });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ n: 2 });
    expect(calls.fail).toBe(2);
    const replay = await request(app).post('/fail').set('Idempotency-Key', 'key-fail-0001').send({ a: 1 });
    expect(replay.body).toEqual({ n: 2 });
    expect(calls.fail).toBe(2);
  });

  it('client abort mid-handler does NOT release the key: retry gets IN_PROGRESS, then the replay; handler ran once', async () => {
    const body = JSON.stringify({ a: 1 });
    await new Promise<void>((resolve) => {
      const r = httpRequest(`${baseUrl}/abortable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'idempotency-key': 'key-abort-0001' },
      });
      r.on('error', () => resolve());
      r.end(body);
      setTimeout(() => {
        r.destroy();
        resolve();
      }, 100);
    });
    await sleep(50);
    const during = await request(app).post('/abortable').set('Idempotency-Key', 'key-abort-0001').send({ a: 1 });
    expect(during.status).toBe(409);
    expect(during.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    await sleep(500);
    const after = await request(app).post('/abortable').set('Idempotency-Key', 'key-abort-0001').send({ a: 1 });
    expect(after.status).toBe(201);
    expect(after.body).toEqual({ n: 1 });
    expect(after.headers['idempotent-replayed']).toBe('true');
    expect(calls.abort).toBe(1);
  });

  it('a slow original cannot clobber the record of a request that took over its stale lock', async () => {
    const send = () => request(app).post('/takeover').set('Idempotency-Key', 'key-take-0001').send({ t: 1 });
    const original = send().then((r) => r); // supertest is lazy: start it now
    await sleep(350); // original still running; its lock (0.2 s) is stale
    const takeover = await send();
    expect(takeover.status).toBe(201);
    expect(takeover.body).toEqual({ n: 2 });
    const first = await original;
    expect(first.body).toEqual({ n: 1 });
    await sleep(50);
    const replay = await send();
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual({ n: 2 });
    expect(calls.takeover).toBe(2);
  });

  it('replays byte-identical JSON (undefined fields, Dates, mongoose documents, null)', async () => {
    for (const [kind, key] of [['plain', 'key-shape-plain'], ['doc', 'key-shape-doc1'], ['null', 'key-shape-null']] as const) {
      const before = calls.shapes!;
      const first = await request(app).post('/shapes').set('Idempotency-Key', key).send({ kind });
      const again = await request(app).post('/shapes').set('Idempotency-Key', key).send({ kind });
      expect(calls.shapes! - before).toBe(1);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.status).toBe(first.status);
      expect(again.text).toBe(first.text);
      expect(again.headers['content-type']).toMatch(/application\/json/);
    }
    const plain = await request(app).post('/shapes').set('Idempotency-Key', 'key-shape-plain').send({ kind: 'plain' });
    expect(plain.text).toBe('{"a":1,"nested":{"d":"1970-01-01T00:00:00.000Z","arr":[null,1]}}');
    const nul = await request(app).post('/shapes').set('Idempotency-Key', 'key-shape-null').send({ kind: 'null' });
    expect(nul.text).toBe('null');
  });
});
