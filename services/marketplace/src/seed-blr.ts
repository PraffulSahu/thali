/**
 * Marketplace slice of the Bengaluru dataset (`@thali/contracts/seed-blr`), bulk + idempotent:
 *  - cuisines for all 18 slugs of cuisines.json (with photos; seed-owned cuisines missing a photo get one)
 *  - ~600 restaurants (`blr:restaurant:<i>`): locality, real street address, pureVeg, hours, packaging fee,
 *    prep minutes, food-forward cover photo (signature dish; matching interior shots for cafés / bakeries /
 *    sweet shops), statuses incl. pending approvals, ratingSum/ratingCount = the seeded ratings exactly
 *  - menus: categories + ~15k items with photos (`imageKey`), variants / add-ons, sold-out and unavailable
 *    items, up to 6 featured
 *  - city-wide + restaurant-scoped coupons (`restaurantIds`, `badgeLabel`), usedCount = REDEEMED redemptions
 *  - Thali Plus memberships with usage matching the checkouts that used them; ratings for delivered children
 * Then `recomputeMenuStats`, `recomputeSearchTokens` and `upsertLocalities(localities.json)` so discovery,
 * search and the gazetteer are consistent at once. KYC files are 3 shared demo PDFs.
 */
import type { Connection } from 'mongoose';
import {
  BLR_PLAN,
  BLR_PLAN_ID,
  BLR_RESTAURANT_DOC_TYPES,
  blrRestaurantDocKey,
  imageRef,
  type BlrRestaurant,
  type BlrWorld,
} from '@thali/contracts/seed-blr';
import { seedId } from '@thali/contracts/seed';
import { encryptField } from '@thali/service-kit';
import { demoPdf, ensureDocsBulk, uploadSeedObjects, type SeedReport } from '@thali/service-kit/seed';
import type { MarketplaceSeedConfig } from './seed.js';
import { upsertLocalities } from './domain/localities.js';
import { recomputeMenuStats, recomputeSearchTokens } from './domain/menu-stats.js';
import { getModels } from './models/index.js';

const pt = (p: { lat: number; lng: number }) => ({ type: 'Point', coordinates: [p.lng, p.lat] });
const ADMIN = seedId('user:admin');

function restaurantDoc(w: BlrWorld, r: BlrRestaurant, fieldKey: string) {
  const created = w.daysAgo(r.createdDaysAgo, -r.i % 600);
  const at = (h: number) => new Date(created.getTime() + h * 3_600_000);
  const history: Record<string, unknown>[] = [{ from: 'DRAFT', to: 'VERIFICATION_PENDING', actorId: r.ownerUserId, at: at(0.5) }];
  if (r.status !== 'VERIFICATION_PENDING') history.push({ from: 'VERIFICATION_PENDING', to: 'APPROVAL_PENDING', actorId: r.ownerUserId, at: at(2) });
  if (r.status === 'APPROVED' || r.status === 'SUSPENDED') history.push({ from: 'APPROVAL_PENDING', to: 'APPROVED', actorId: ADMIN, reason: 'Documents verified', at: at(20) });
  if (r.status === 'SUSPENDED') history.push({ from: 'APPROVED', to: 'SUSPENDED', actorId: ADMIN, reason: r.statusReason, at: w.daysAgo(3) });
  if (r.status === 'REJECTED') history.push({ from: 'APPROVAL_PENDING', to: 'REJECTED', actorId: ADMIN, reason: r.statusReason, at: at(26) });
  const verified = r.status === 'APPROVED' || r.status === 'SUSPENDED';
  return {
    _id: r.id,
    ownerUserId: r.ownerUserId,
    businessName: r.businessName,
    name: r.name,
    slug: r.slug,
    description: r.description,
    cuisines: r.cuisines,
    phone: r.phone,
    businessEmail: r.businessEmail,
    ...(r.status === 'VERIFICATION_PENDING' ? {} : { emailVerifiedAt: at(1) }),
    address: r.address,
    location: pt(r.location),
    deliveryRadiusKm: r.deliveryRadiusKm,
    hours: r.hours,
    timezone: 'Asia/Kolkata',
    status: r.status,
    ...(r.statusReason ? { statusReason: r.statusReason } : {}),
    statusHistory: history,
    images: r.coverRef ? { cover: r.coverRef } : {},
    documents: BLR_RESTAURANT_DOC_TYPES.map((type) => ({ _id: seedId(`blr:restaurant-doc:${r.i}:${type}`), type, key: blrRestaurantDocKey(type), verified, uploadedAt: at(1.5) })),
    settlement: { accountHolder: r.businessName, accountNumberEnc: encryptField(r.accountNumber, fieldKey), ifsc: r.ifsc, last4: r.accountNumber.slice(-4), updatedAt: at(1.5) },
    pureVeg: r.pureVeg,
    packagingFeePaise: r.packagingFeePaise,
    avgPrepMinutes: r.avgPrepMinutes,
    commissionBps: r.commissionBps,
    ratingSum: r.ratingSum,
    ratingCount: r.ratingCount,
    isDemo: true,
    createdAt: created,
    updatedAt: history.length ? (history[history.length - 1]!.at as Date) : created,
  };
}

export async function seedMarketplaceBlr(conn: Connection, w: BlrWorld, cfg: MarketplaceSeedConfig, log: (s: string) => void = (s) => process.stdout.write(s)): Promise<SeedReport> {
  const m = getModels(conn);
  const report: SeedReport = {};
  const sfx = ' (blr)';

  // cuisines: all slugs of cuisines.json (ids shared with the demo seed's `cuisine:<slug>`)
  const existing = new Map((await m.Cuisine.find({}, { slug: 1, imageKey: 1, isDemo: 1 }).lean<{ _id: unknown; slug: string; imageKey?: string; isDemo?: boolean }[]>()).map((c) => [c.slug, c]));
  const ordered = [...w.data.cuisines].sort((a, b) => b.weight - a.weight);
  await ensureDocsBulk(
    m.Cuisine,
    ordered.filter((c) => !existing.has(c.slug)).map((c) => ({ _id: seedId(`cuisine:${c.slug}`), slug: c.slug, name: c.name, imageKey: imageRef(w.data, w.manifest, c.imageId), sortOrder: 10 + ordered.indexOf(c), active: true, isDemo: true })),
    report,
    { label: `cuisines${sfx}` },
  );
  for (const c of ordered) {
    const e = existing.get(c.slug);
    const ref = imageRef(w.data, w.manifest, c.imageId);
    if (e?.isDemo && !e.imageKey && ref) await m.Cuisine.updateOne({ _id: e._id, isDemo: true, imageKey: { $exists: false } }, { $set: { imageKey: ref } });
  }

  await ensureDocsBulk(m.Restaurant, (function* () {
    for (const r of w.restaurants) yield restaurantDoc(w, r, cfg.FIELD_ENCRYPTION_KEY);
  })(), report, { label: `restaurants${sfx}`, chunk: 300 });

  await ensureDocsBulk(m.MenuCategory, (function* () {
    for (const r of w.restaurants) for (const c of r.categories) yield { _id: c.id, restaurantId: r.id, name: c.name, sortOrder: c.sortOrder, active: true, isDemo: true, createdAt: w.daysAgo(r.createdDaysAgo), updatedAt: w.daysAgo(r.createdDaysAgo) };
  })(), report, { label: `menu_categories${sfx}` });

  await ensureDocsBulk(m.MenuItem, (function* () {
    for (const r of w.restaurants) {
      const at = w.daysAgo(r.createdDaysAgo, 30);
      for (const it of r.items) {
        yield {
          _id: it.id,
          restaurantId: r.id,
          categoryId: it.categoryId,
          name: it.name,
          description: it.description,
          pricePaise: it.pricePaise,
          isVeg: it.isVeg,
          ...(it.imageKey ? { imageKey: it.imageKey } : {}),
          available: it.available,
          trackStock: it.trackStock,
          stockQty: it.stockQty,
          reservedQty: 0,
          tags: it.tags,
          featured: it.featured,
          isDemo: true,
          customizationGroups: it.groups.map((g) => ({
            _id: g.id,
            name: g.name,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            options: g.options.map((o) => ({ _id: o.id, name: o.name, pricePaise: o.pricePaise, isVeg: o.isVeg, available: o.available })),
          })),
          createdAt: at,
          updatedAt: at,
        };
      }
    }
  })(), report, { label: `menu_items${sfx}` });

  const validFrom = w.daysAgo(120);
  const validTo = new Date('2027-12-31T18:29:59.000Z');
  await ensureDocsBulk(
    m.Coupon,
    w.coupons.map((c) => ({
      _id: c.id,
      code: c.code,
      description: c.description,
      type: c.type,
      ...(c.valuePaise !== undefined ? { valuePaise: c.valuePaise } : {}),
      ...(c.valueBps !== undefined ? { valueBps: c.valueBps } : {}),
      ...(c.maxDiscountPaise !== undefined ? { maxDiscountPaise: c.maxDiscountPaise } : {}),
      minOrderPaise: c.minOrderPaise,
      validFrom,
      validTo,
      totalLimit: null,
      perUserLimit: c.perUserLimit,
      usedCount: c.usedCount,
      heldCount: 0,
      active: true,
      firstOrderOnly: false,
      restaurantIds: c.restaurantIds,
      ...(c.badgeLabel ? { badgeLabel: c.badgeLabel } : {}),
      isDemo: true,
      createdAt: validFrom,
      updatedAt: validFrom,
    })),
    report,
    { label: `coupons${sfx}` },
  );

  await ensureDocsBulk(m.CouponRedemption, (function* () {
    for (const co of w.checkouts) {
      if (!co.coupon) continue;
      yield {
        _id: seedId(`blr:coupon-redemption:${co.n}`),
        couponId: co.coupon.id,
        code: co.coupon.code,
        userId: co.consumer.id,
        checkoutId: co.id,
        status: 'REDEEMED',
        discountPaise: co.totals.couponDiscountPaise,
        expiresAt: new Date(co.createdAt.getTime() + 15 * 60_000),
        createdAt: co.createdAt,
        updatedAt: co.placedAt,
      };
    }
  })(), report, { label: `coupon_redemptions${sfx}` });

  await ensureDocsBulk(
    m.Membership,
    w.memberships.map((ms) => ({
      _id: ms.id,
      userId: ms.userId,
      planId: BLR_PLAN_ID,
      planSnapshot: { name: BLR_PLAN.name, pricePaise: BLR_PLAN.pricePaise, durationDays: BLR_PLAN.durationDays, benefits: { ...BLR_PLAN.benefits }, terms: BLR_PLAN.terms },
      status: ms.status,
      startsAt: ms.startsAt,
      endsAt: ms.endsAt,
      paymentIntentId: ms.paymentIntentId,
      lastAttemptAt: new Date(ms.startsAt.getTime() - 60_000),
      freeDeliveriesUsed: ms.freeDeliveriesUsed,
      freeDeliveriesHeld: 0,
      usage: ms.usage.map((u) => ({ checkoutId: u.checkoutId, freeDeliveries: u.freeDeliveries, discountPaise: u.discountPaise, status: 'USED', at: u.at })),
      createdAt: new Date(ms.startsAt.getTime() - 90_000),
      updatedAt: ms.usage.length ? ms.usage[ms.usage.length - 1]!.at : ms.startsAt,
    })),
    report,
    { label: `memberships${sfx}` },
  );

  await ensureDocsBulk(m.Rating, (function* () {
    for (const co of w.checkouts) {
      for (const ch of co.children) {
        if (!ch.rating) continue;
        yield { _id: ch.rating.id, restaurantId: ch.restaurant.id, childOrderId: ch.id, userId: co.consumer.id, stars: ch.rating.stars, comment: ch.rating.comment, createdAt: ch.rating.at, updatedAt: ch.rating.at };
      }
    }
  })(), report, { label: `ratings${sfx}` });

  if (cfg.S3_ENDPOINT || cfg.S3_ACCESS_KEY_ID) {
    await uploadSeedObjects(
      {
        ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}),
        region: cfg.S3_REGION,
        ...(cfg.S3_ACCESS_KEY_ID ? { accessKeyId: cfg.S3_ACCESS_KEY_ID } : {}),
        ...(cfg.S3_SECRET_ACCESS_KEY ? { secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : {}),
        publicBucket: cfg.S3_PUBLIC_BUCKET,
      },
      BLR_RESTAURANT_DOC_TYPES.map((type) => ({ bucket: cfg.S3_PRIVATE_BUCKET, key: blrRestaurantDocKey(type), contentType: 'application/pdf', body: demoPdf(`Demo restaurant ${type} certificate`) })),
      report,
      `objects (S3)${sfx}`,
    );
  }

  // derived read models: menu stats, search tokens (normally set by the validate hook), gazetteer
  const t0 = Date.now();
  const stats = await recomputeMenuStats(conn);
  const tokens = await recomputeSearchTokens(conn, { onlyMissing: true });
  const loc = await upsertLocalities(conn, w.data.localities);
  log(`[seed:marketplace] menuStats ${stats} restaurants, searchTokens backfilled ${tokens}, gazetteer ${loc.localities} localities + ${loc.roads} roads (${Date.now() - t0} ms)\n`);
  return report;
}
