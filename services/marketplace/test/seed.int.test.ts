import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedId } from '@thali/contracts/seed';
import { createTestDb, type TestDb } from '@thali/service-kit/testing';
import { ensureMarketplaceIndexes, getModels } from '../src/models/index.js';
import { BLR_CITY_POLYGON, BLR_LEGACY_DEMO_POLYGON } from '@thali/contracts/seed-blr';
import { LEGACY_DEMO_AREA_NAME, seedMarketplace } from '../src/seed.js';

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

  it('fresh install: Green Leaf pure veg, demo localities, one city-wide "Bengaluru" area', async () => {
    const m = getModels(db.conn);
    const gl = (await m.Restaurant.findById(seedId('restaurant:green-leaf')).lean())!;
    expect(gl.pureVeg).toBe(true);
    expect(gl.address?.locality).toBe('Koramangala 1st Block');
    expect((await m.Restaurant.findById(seedId('restaurant:spice-route')).lean())!.pureVeg).toBe(false);
    const area = (await m.ServiceArea.findById(seedId('service-area:blr-koramangala')).lean())!;
    expect(area.name).toBe('Bengaluru');
    expect(area.polygon.coordinates).toEqual(BLR_CITY_POLYGON.coordinates);
    expect(await m.ServiceArea.countDocuments({})).toBe(1);
  });

  it('existing install: upgrades the stored default pureVeg=false, the legacy box and name, and missing localities', async () => {
    const m = getModels(db.conn);
    const glId = seedId('restaurant:green-leaf');
    const areaId = seedId('service-area:blr-koramangala');
    await m.Restaurant.updateOne({ _id: glId }, { $set: { pureVeg: false }, $unset: { 'address.locality': '' } });
    await m.ServiceArea.updateOne({ _id: areaId }, { $set: { name: LEGACY_DEMO_AREA_NAME, 'polygon.coordinates': BLR_LEGACY_DEMO_POLYGON } });
    await seedMarketplace(db.conn, cfg);
    const gl = (await m.Restaurant.findById(glId).lean())!;
    expect(gl.pureVeg).toBe(true);
    expect(gl.address?.locality).toBe('Koramangala 1st Block');
    const area = (await m.ServiceArea.findById(areaId).lean())!;
    expect(area.name).toBe('Bengaluru');
    expect(area.polygon.coordinates).toEqual(BLR_CITY_POLYGON.coordinates);

    // an admin-renamed area keeps its name (only the legacy polygon is upgraded)
    await m.ServiceArea.updateOne({ _id: areaId }, { $set: { name: 'Namma Bengaluru', 'polygon.coordinates': BLR_LEGACY_DEMO_POLYGON } });
    await seedMarketplace(db.conn, cfg);
    const renamed = (await m.ServiceArea.findById(areaId).lean())!;
    expect(renamed.name).toBe('Namma Bengaluru');
    expect(renamed.polygon.coordinates).toEqual(BLR_CITY_POLYGON.coordinates);
  });
});
