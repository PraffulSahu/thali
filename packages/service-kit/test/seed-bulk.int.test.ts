import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Schema } from 'mongoose';
import { ensureDocsBulk, SeedConflictError, type SeedReport } from '@thali/service-kit/seed';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';

let db: TestDb;
const schema = new Schema(
  { phone: { type: String, required: true }, name: { type: String, default: 'anon' }, isDemo: { type: Boolean, default: false } },
  { collection: 'bulk_people', timestamps: true, optimisticConcurrency: true },
);
schema.index({ phone: 1 }, { unique: true });

beforeAll(async () => {
  db = await createTestDb('kit_seed_bulk');
});
afterAll(async () => {
  await db.drop();
});

const People = () => db.conn.models.BulkPerson ?? db.conn.model('BulkPerson', schema);
const hexId = (n: number) => n.toString(16).padStart(24, '0');

describe('ensureDocsBulk', () => {
  it('inserts in chunks with schema defaults and explicit timestamps; a re-run inserts nothing and never overwrites', async () => {
    const M = People();
    await M.init();
    const docs = Array.from({ length: 25 }, (_, i) => ({ _id: hexId(i + 1), phone: `+91${i}`, isDemo: true }));
    docs[3] = { ...docs[3]!, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') } as never;

    const first: SeedReport = {};
    await ensureDocsBulk(M, docs, first, { chunk: 10 });
    expect(first).toEqual({ bulk_people: { inserted: 25, existing: 0 } });

    const a = await M.findById(hexId(1)).lean<Record<string, unknown>>();
    expect(a).toMatchObject({ phone: '+910', name: 'anon', isDemo: true, __v: 0 });
    expect(a!.createdAt).toBeInstanceOf(Date);
    const d = await M.findById(hexId(4)).lean<Record<string, unknown>>();
    expect((d!.createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((d!.updatedAt as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z');

    await M.updateOne({ _id: hexId(1) }, { $set: { name: 'changed in app' } });
    const second: SeedReport = {};
    await ensureDocsBulk(M, [...docs, { _id: hexId(26), phone: '+9126' }], second, { chunk: 7, label: 'people' });
    expect(second).toEqual({ people: { inserted: 1, existing: 25 } });
    expect((await M.findById(hexId(1)).lean<{ name: string }>())!.name).toBe('changed in app');
  });

  it('accepts async iterables (streamed generation)', async () => {
    const M = People();
    async function* gen() {
      for (let i = 100; i < 105; i++) yield { _id: hexId(i), phone: `+92${i}` };
    }
    const r: SeedReport = {};
    await ensureDocsBulk(M, gen(), r, { chunk: 2 });
    expect(r.bulk_people).toEqual({ inserted: 5, existing: 0 });
  });

  it('a duplicate _id inside the input counts as existing (race semantics)', async () => {
    const M = People();
    const r: SeedReport = {};
    await ensureDocsBulk(M, [{ _id: hexId(200), phone: '+93200' }, { _id: hexId(200), phone: '+93200' }], r);
    expect(r.bulk_people).toEqual({ inserted: 1, existing: 1 });
  });

  it('a unique clash with a non-seed document is a SeedConflictError naming the key; other docs still land', async () => {
    const M = People();
    await M.create({ phone: '+94999' });
    const r: SeedReport = {};
    await expect(
      ensureDocsBulk(M, [{ _id: hexId(300), phone: '+94999' }, { _id: hexId(301), phone: '+94301' }], r),
    ).rejects.toSatisfy((e: unknown) => e instanceof SeedConflictError && /\+94999/.test((e as Error).message));
    expect(await M.exists({ _id: hexId(301) })).toBeTruthy();
  });

  it('requires a deterministic _id and validates through the model', async () => {
    const M = People();
    await expect(ensureDocsBulk(M, [{ phone: '+95000' }], {})).rejects.toThrow(/_id/);
    await expect(ensureDocsBulk(M, [{ _id: hexId(400) }], {})).rejects.toThrow(/phone/);
    expect(await M.exists({ _id: hexId(400) })).toBeFalsy();
  });
});
