import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';

let db: TestDb;
let A: mongoose.Model<{ name: string }>;
let B: mongoose.Model<{ name: string }>;

beforeAll(async () => {
  db = await createTestDb('kit_txn');
  A = db.conn.model('A', new Schema<{ name: string }>({ name: String }), 'txn_a');
  B = db.conn.model('B', new Schema<{ name: string }>({ name: String }), 'txn_b');
  // collections must exist before use inside a transaction on older servers; create up-front
  await Promise.all([A.createCollection(), B.createCollection()]);
});

afterAll(async () => {
  await db.drop();
});

describe('withTransaction', () => {
  it('commits both documents and returns the callback value', async () => {
    const out = await withTransaction(db.conn, async (session) => {
      await A.create([{ name: 'commit' }], { session });
      await B.create([{ name: 'commit' }], { session });
      return 'done';
    });
    expect(out).toBe('done');
    expect(await A.countDocuments({ name: 'commit' })).toBe(1);
    expect(await B.countDocuments({ name: 'commit' })).toBe(1);
  });

  it('throwing inside rolls back both and rethrows the original error', async () => {
    const err = new DomainError('OUT_OF_STOCK', 'nope');
    await expect(
      withTransaction(db.conn, async (session) => {
        await A.create([{ name: 'rollback' }], { session });
        await B.create([{ name: 'rollback' }], { session });
        throw err;
      }),
    ).rejects.toBe(err);
    expect(await A.countDocuments({ name: 'rollback' })).toBe(0);
    expect(await B.countDocuments({ name: 'rollback' })).toBe(0);
  });

  it('retries the callback on TransientTransactionError', async () => {
    let attempts = 0;
    const out = await withTransaction(db.conn, async (session) => {
      attempts += 1;
      await A.create([{ name: `retry-${attempts}` }], { session });
      if (attempts === 1) {
        const e = new mongoose.mongo.MongoServerError({ message: 'write conflict', code: 112 });
        e.addErrorLabel('TransientTransactionError');
        throw e;
      }
      return attempts;
    });
    expect(out).toBe(2);
    expect(await A.countDocuments({ name: 'retry-1' })).toBe(0);
    expect(await A.countDocuments({ name: 'retry-2' })).toBe(1);
  });
});
