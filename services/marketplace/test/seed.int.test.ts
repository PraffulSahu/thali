import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedId } from '@thali/contracts/seed';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';
import { ensureMarketplaceIndexes, getModels } from '../src/models/index.js';
import { seedMarketplace } from '../src/seed.js';

let db: TestDb;
const cfg = {
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_REGION: 'us-east-1',
  S3_PUBLIC_BUCKET: 'thali-public',
  S3_PRIVATE_BUCKET: 'thali-private',
}; // no S3 endpoint/keys: demo files are skipped

beforeAll(async () => {
  db = await createTestDb('marketplace_seed');
  await ensureMarketplaceIndexes(db.conn);
});
afterAll(async () => {
  await db.drop();
});

describe('seedMarketplace', () => {
  it('seeds the demo catalog with every document flagged isDemo, incl. one labelled banner; idempotent', async () => {
    const first = await seedMarketplace(db.conn, cfg);
    expect(first).toMatchObject({
      restaurants: { inserted: 4, existing: 0 },
      coupons: { inserted: 2, existing: 0 },
      membership_plans: { inserted: 1, existing: 0 },
      banners: { inserted: 1, existing: 0 },
    });
    const m = getModels(db.conn);
    for (const model of [m.Restaurant, m.MenuCategory, m.MenuItem, m.ServiceArea, m.Cuisine, m.Banner, m.Coupon, m.MembershipPlan]) {
      const total = await model.countDocuments({});
      expect(total, model.modelName).toBeGreaterThan(0);
      expect(await model.countDocuments({ isDemo: true }), model.modelName).toBe(total);
    }
    const banner = (await m.Banner.findById(seedId('banner:welcome50')).lean())!;
    expect(banner).toMatchObject({ linkType: 'COUPON', linkValue: 'WELCOME50', active: true });
    expect(banner.title).toMatch(/^DEMO/);
    const rogan = (await m.MenuItem.findById(seedId('item:spice-route:mutton-rogan-josh')).lean())!;
    expect(rogan).toMatchObject({ trackStock: true, stockQty: 3 });

    const second = await seedMarketplace(db.conn, cfg);
    expect(Object.values(second).every((t) => t.inserted === 0)).toBe(true);
  });
});
