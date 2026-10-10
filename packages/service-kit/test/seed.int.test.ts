import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Schema } from 'mongoose';
import { assertDemoSeedAllowed, ensureDocs, printSeedReport, SeedConflictError, totalInserted, type SeedReport } from '@thali/service-kit/seed';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';

let db: TestDb;
const schema = new Schema(
  { phone: { type: String, required: true }, name: { type: String, default: 'anon' }, isDemo: { type: Boolean, default: false } },
  { collection: 'people', timestamps: true, optimisticConcurrency: true },
);
schema.index({ phone: 1 }, { unique: true });

beforeAll(async () => {
  db = await createTestDb('kit_seed');
});
afterAll(async () => {
  await db.drop();
});

const People = () => db.conn.models.Person ?? db.conn.model('Person', schema);

describe('ensureDocs', () => {
  it('inserts with schema defaults, then a second run inserts nothing and never overwrites', async () => {
    const M = People();
    await M.init();
    const docs = [
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', phone: '+911', isDemo: true },
      { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', phone: '+912', name: 'B', isDemo: true, createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const first: SeedReport = {};
    await ensureDocs(M, docs, first);
    expect(first).toEqual({ people: { inserted: 2, existing: 0 } });

    const a = await M.findById('aaaaaaaaaaaaaaaaaaaaaaaa').lean<Record<string, unknown>>();
    expect(a).toMatchObject({ phone: '+911', name: 'anon', isDemo: true, __v: 0 });
    const b = await M.findById('bbbbbbbbbbbbbbbbbbbbbbbb').lean<Record<string, unknown>>();
    expect((b!.createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z'); // back-dated history kept

    await M.updateOne({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, { $set: { name: 'changed in app' } });
    const second: SeedReport = {};
    await ensureDocs(M, docs, second);
    expect(second).toEqual({ people: { inserted: 0, existing: 2 } });
    expect(totalInserted(second)).toBe(0);
    expect((await M.findById('aaaaaaaaaaaaaaaaaaaaaaaa').lean<{ name: string }>())!.name).toBe('changed in app');
  });

  it('a unique clash with a non-seed document is a SeedConflictError naming the key', async () => {
    const M = People();
    await M.create({ phone: '+913' });
    await expect(ensureDocs(M, [{ _id: 'cccccccccccccccccccccccc', phone: '+913' }], {})).rejects.toBeInstanceOf(SeedConflictError);
    await expect(ensureDocs(M, [{ _id: 'cccccccccccccccccccccccc', phone: '+913' }], {})).rejects.toThrow(/\+913/);
  });

  it('requires a deterministic _id and validates through the model', async () => {
    const M = People();
    await expect(ensureDocs(M, [{ phone: '+914' }], {})).rejects.toThrow(/_id/);
    await expect(ensureDocs(M, [{ _id: 'dddddddddddddddddddddddd' }], {})).rejects.toThrow(/phone/);
  });
});

describe('guard + report', () => {
  it('refuses unless APP_MODE=demo', () => {
    expect(() => assertDemoSeedAllowed('production')).toThrow(/Refusing to seed/);
    expect(() => assertDemoSeedAllowed('sandbox')).toThrow(/Refusing to seed/);
    expect(() => assertDemoSeedAllowed(undefined)).toThrow(/Refusing to seed/);
    expect(() => assertDemoSeedAllowed('demo')).not.toThrow();
  });

  it('prints a machine-readable SEED_RESULT line', () => {
    let out = '';
    printSeedReport('x', { a: { inserted: 1, existing: 2 } }, (s) => (out += s));
    const line = out.split('\n').find((l) => l.startsWith('SEED_RESULT '))!;
    expect(JSON.parse(line.slice('SEED_RESULT '.length))).toEqual({ service: 'x', inserted: 1, report: { a: { inserted: 1, existing: 2 } } });
  });
});
