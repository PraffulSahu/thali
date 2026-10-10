import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CHECKOUTS, demoOrderIds } from '@thali/contracts/seed-demo';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';
import { hashCode } from '../src/domain/codes.js';
import { getModels, initDeliveryModels } from '../src/models/index.js';
import { seedDelivery } from '../src/seed.js';

let db: TestDb;
const cfg = { MAX_ACTIVE_DELIVERIES: 2, S3_REGION: 'ap-south-1', S3_PUBLIC_BUCKET: 'thali-public', S3_PRIVATE_BUCKET: 'thali-private' };

beforeAll(async () => {
  db = await createTestDb('delivery_seed');
  await initDeliveryModels(db.conn);
});
afterAll(async () => {
  await db.drop();
});

describe('seedDelivery', () => {
  it('partners in 4 statuses + delivered demo jobs, all isDemo; idempotent', async () => {
    const first = await seedDelivery(db.conn, cfg);
    expect(first).toMatchObject({ partners: { inserted: 4, existing: 0 }, delivery_jobs: { inserted: 2, existing: 0 } });
    const { Partner, Job } = getModels(db.conn);
    expect((await Partner.find().lean()).map((p) => p.status).sort()).toEqual(['APPROVAL_PENDING', 'APPROVED', 'APPROVED', 'SUSPENDED']);
    expect(await Partner.countDocuments({ isDemo: { $ne: true } })).toBe(0);
    expect(await Job.countDocuments({ isDemo: { $ne: true } })).toBe(0);

    const multi = DEMO_CHECKOUTS.find((c) => c.code === 'TH-DEMOMULTI')!;
    const a = multi.children[0]!;
    const job = (await Job.findById(demoOrderIds.job(multi, a)).lean())!;
    expect(job).toMatchObject({ status: 'DELIVERED', childOrderId: demoOrderIds.child(multi, a), distanceKm: a.distanceKm });
    expect(job.deliveryCodeHash).toBe(hashCode(demoOrderIds.child(multi, a), a.deliveryCode));

    const second = await seedDelivery(db.conn, cfg);
    expect(Object.values(second).every((t) => t.inserted === 0)).toBe(true);
  });
});
