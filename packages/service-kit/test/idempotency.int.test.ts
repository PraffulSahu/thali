import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, idempotency } from '@thali/service-kit';
import { createTestConfig, createTestDb, testLogger, type TestDb } from '@thali/service-kit/testing';

let db: TestDb;
let app: ReturnType<typeof createApp>;
const calls: Record<string, number> = { create: 0, fail: 0, slow: 0, optional: 0 };

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
      a.post('/optional', idempotency({ scope: 'opt', conn: db.conn, required: false }), (_req, res) => {
        calls.optional! += 1;
        res.json({ n: calls.optional });
      });
    },
  });
});

afterAll(async () => {
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
    expect(doc).toMatchObject({ status: 'COMPLETED', responseStatus: 201, responseBody: first.body });
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
});
