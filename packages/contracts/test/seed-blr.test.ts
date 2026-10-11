import { beforeAll, describe, expect, it } from 'vitest';
import * as pricing from '@thali/pricing';
import {
  BLR_DEMO_DROP,
  BLR_PLAN,
  BLR_PRICING_CONFIG,
  EMPTY_MANIFEST,
  blrCouponDiscount,
  blrDeliveryLedger,
  blrWeeklyPayouts,
  buildBlrWorld,
  haversineKm,
  istMinuteOfDay,
  loadBlrData,
  type BlrWorld,
} from '../src/seed-blr.js';
import { DEMO_CHECKOUTS } from '../src/seed-demo.js';

const ANCHOR = new Date('2026-10-11T08:00:00.000Z'); // 13:30 IST
const data = loadBlrData();
let w: BlrWorld;
let again: BlrWorld;
let shifted: BlrWorld;

beforeAll(() => {
  w = buildBlrWorld({ pricing, anchor: ANCHOR, data, manifest: EMPTY_MANIFEST });
  again = buildBlrWorld({ pricing, anchor: ANCHOR, data, manifest: EMPTY_MANIFEST });
  shifted = buildBlrWorld({ pricing, anchor: new Date('2026-10-14T21:17:00.000Z'), data, manifest: EMPTY_MANIFEST });
}, 30_000);

const fingerprint = (x: BlrWorld) =>
  JSON.stringify({
    r: x.restaurants.map((r) => [r.id, r.slug, r.status, r.pureVeg, r.ratingSum, r.ratingCount, r.items.length, r.coverRef]),
    u: [...x.consumers, ...x.owners, ...x.partners].map((u) => [u.id, u.phone, u.name, u.avatarKey]),
    c: x.checkouts.map((c) => [c.id, c.code, c.status, c.totals.totalPaise, c.coupon?.code ?? null, c.membership?.id ?? null, c.children.map((ch) => [ch.id, ch.code, ch.outcome.kind, ch.partner?.id ?? null, ch.rating?.stars ?? null])]),
    k: x.coupons.map((c) => [c.code, c.usedCount]),
    t: x.tickets.map((t) => [t.id, t.code, t.status]),
  });

describe('seed-blr generator: determinism', () => {
  it('produces the same world for the same anchor', () => {
    expect(fingerprint(again)).toBe(fingerprint(w));
    expect(again.checkouts[1234]!.placedAt.toISOString()).toBe(w.checkouts[1234]!.placedAt.toISOString());
  });

  it('keeps the structure (ids, amounts, outcomes, ratings) when only the anchor moves', () => {
    expect(fingerprint(shifted)).toBe(fingerprint(w));
    expect(shifted.checkouts[0]!.placedAt.getTime()).not.toBe(w.checkouts[0]!.placedAt.getTime());
    const payoutIds = (x: BlrWorld) => blrWeeklyPayouts(x).map((p) => `${p.id}:${p.amountPaise}`).join();
    expect(payoutIds(shifted)).toBe(payoutIds(w));
  });

  it('never reuses an id or code of the demo story', () => {
    const demoCodes = new Set(DEMO_CHECKOUTS.flatMap((c) => [c.code, ...c.children.map((ch) => ch.code)]));
    const codes = w.checkouts.flatMap((c) => [c.code, ...c.children.map((ch) => ch.code)]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^TH-[0-9A-HJKMNP-TV-Z]{8}$/.test(c) && !demoCodes.has(c))).toBe(true);
  });
});

describe('seed-blr generator: pricing consistency', () => {
  it('every checkout equals @thali/pricing priceCheckout over its generated lines', () => {
    for (const co of w.checkouts) {
      const free = co.children.filter((ch) => ch.breakdown.deliveryDiscountPaise > 0).map((ch) => ch.restaurant.id);
      const priced = pricing.priceCheckout(
        co.children.map((ch) => ({
          restaurantId: ch.restaurant.id,
          packagingFeePaise: ch.restaurant.packagingFeePaise,
          deliveryFeePaise: ch.breakdown.deliveryFeePaise,
          lines: ch.lines.map((l) => ({ itemId: l.itemId, name: l.name, unitPricePaise: l.unitPricePaise, quantity: l.quantity, addOns: l.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })) })),
        })),
        co.coupon ? { couponCode: co.coupon.code, couponDiscountPaise: co.totals.couponDiscountPaise, ...(co.coupon.restaurantIds.length ? { couponRestaurantIds: co.coupon.restaurantIds } : {}) } : { couponDiscountPaise: 0 },
        co.membership ? { freeDeliveryRestaurantIds: free, extraDiscountBps: BLR_PLAN.benefits.extraDiscountBps, extraDiscountCapPaise: BLR_PLAN.benefits.extraDiscountCapPaise } : null,
        BLR_PRICING_CONFIG,
      );
      expect(priced.totals).toEqual(co.totals);
      for (const ch of co.children) {
        expect(priced.children.find((p) => p.restaurantId === ch.restaurant.id)!.breakdown).toEqual(ch.breakdown);
        expect(ch.breakdown.deliveryFeePaise).toBe(pricing.computeDeliveryFee(ch.distanceKm, { basePaise: 2500, baseKm: 2, perKmPaise: 800, maxPaise: 8000 }));
      }
    }
  });

  it('lines only use orderable items and valid option selections of their restaurant', () => {
    for (const co of w.checkouts.slice(0, 1500)) {
      for (const ch of co.children) {
        for (const l of ch.lines) {
          const it = ch.restaurant.items.find((x) => x.id === l.itemId)!;
          expect(it.available && !it.trackStock).toBe(true);
          expect(l.unitPricePaise).toBe(it.pricePaise);
          for (const g of it.groups) {
            const picked = l.addOns.filter((a) => a.groupId === g.id);
            expect(picked.length).toBeGreaterThanOrEqual(g.minSelect);
            expect(picked.length).toBeLessThanOrEqual(g.maxSelect);
            for (const a of picked) expect(g.options.find((o) => o.id === a.id)?.pricePaise).toBe(a.pricePaise);
          }
        }
      }
    }
  });

  it('coupons and Thali Plus follow their rules; refunds cover the closed children', () => {
    const uses = new Map<string, number>();
    for (const co of w.checkouts) {
      if (co.coupon) {
        const eligible = co.children.filter((ch) => !co.coupon!.restaurantIds.length || co.coupon!.restaurantIds.includes(ch.restaurant.id)).reduce((s, ch) => s + ch.breakdown.itemsSubtotalPaise, 0);
        expect(eligible).toBeGreaterThanOrEqual(co.coupon.minOrderPaise);
        expect(co.totals.couponDiscountPaise).toBe(blrCouponDiscount(co.coupon, eligible));
        const key = `${co.coupon.code}|${co.consumer.id}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
        expect(uses.get(key)).toBeLessThanOrEqual(co.coupon.perUserLimit);
        expect(co.children.some((ch) => ch.outcome.kind === 'DELIVERED')).toBe(true);
      }
      const refunded = co.children.reduce((s, ch) => s + ch.refundPaise, 0);
      expect(refunded).toBe(co.refundedPaise);
      expect(co.paymentStatus).toBe(refunded === 0 ? 'CAPTURED' : refunded === co.totals.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
    }
    for (const c of w.coupons) expect(c.usedCount).toBe(w.checkouts.filter((co) => co.coupon?.id === c.id).length);
    for (const m of w.memberships) {
      expect(m.freeDeliveriesUsed).toBeLessThanOrEqual(BLR_PLAN.benefits.freeDeliveriesPerPeriod);
      expect(m.freeDeliveriesUsed).toBe(m.usage.reduce((s, u) => s + u.freeDeliveries, 0));
      for (const u of m.usage) expect(u.at.getTime()).toBeGreaterThanOrEqual(m.startsAt.getTime() - 86_400_000);
    }
  });

  it('ledger never pays out more than was earned (weekly payouts, unique UTRs)', () => {
    const payouts = blrWeeklyPayouts(w);
    expect(new Set(payouts.map((p) => p.utr)).size).toBe(payouts.length);
    const bal = new Map<string, number>();
    for (const e of blrDeliveryLedger(w)) bal.set(e.accountId, (bal.get(e.accountId) ?? 0) + e.amountPaise);
    for (const p of payouts) bal.set(p.accountId, (bal.get(p.accountId) ?? 0) - p.amountPaise);
    expect([...bal.values()].every((b) => b >= 0)).toBe(true);
    expect(payouts.every((p) => p.paidAt.getTime() <= ANCHOR.getTime() && /^[A-Z]{4}N\d{12}$/.test(p.utr))).toBe(true);
  });
});

describe('seed-blr generator: distributions', () => {
  it('~600 restaurants over all 71 localities, owners with branches, statuses for the admin queue', () => {
    expect(w.restaurants).toHaveLength(600);
    expect(new Set(w.restaurants.map((r) => r.locality.name)).size).toBe(71);
    expect(w.owners).toHaveLength(450);
    expect(w.owners.filter((o) => o.restaurantIdx.length === 3)).toHaveLength(30);
    expect(new Set(w.restaurants.map((r) => r.slug)).size).toBe(600);
    const st = (s: string) => w.restaurants.filter((r) => r.status === s).length;
    expect(st('APPROVAL_PENDING')).toBe(8);
    expect(st('VERIFICATION_PENDING')).toBe(5);
    const pureVeg = w.restaurants.filter((r) => r.pureVeg).length / 600;
    expect(pureVeg).toBeGreaterThan(0.14);
    expect(pureVeg).toBeLessThan(0.22);
    for (const r of w.restaurants) {
      expect(haversineKm(r.location, BLR_DEMO_DROP)).toBeGreaterThanOrEqual(1);
      expect(r.address.locality).toBe(r.locality.name);
      expect(r.items.length).toBeGreaterThanOrEqual(14);
      expect(r.items.length).toBeLessThanOrEqual(30);
      expect(r.items.filter((i) => i.featured).length).toBeLessThanOrEqual(6);
      expect(r.coverRef).toMatch(/^https:\/\/(upload\.wikimedia\.org|live\.staticflickr\.com)\//);
      if (r.pureVeg) expect(r.items.every((i) => i.isVeg && i.groups.every((g) => g.options.every((o) => o.isVeg)))).toBe(true);
    }
    const kinds = new Set(w.restaurants.map((r) => r.hoursKind.split('+')[0]));
    for (const k of ['dinner-only', 'late-night', 'breakfast-only', 'split']) expect(kinds.has(k)).toBe(true);
    expect(w.restaurants.some((r) => r.hoursKind.includes('+off-'))).toBe(true);
  });

  it('people: Indian names, phone ranges (= identity DEMO_PHONE_PREFIXES defaults) that never collide with the demo accounts, avatars, addresses', () => {
    const demoPhones = ['+919000000001', '+919000000002', '+919000000003', '+919100000001', '+919100000002', '+919200000001', '+919200000002', '+919200000003', '+919200000004'];
    const phones = [...w.consumers, ...w.owners, ...w.partners].map((u) => u.phone);
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones.some((p) => demoPhones.includes(p))).toBe(false);
    expect(w.consumers.every((c) => /^\+9191010\d{5}$/.test(c.phone))).toBe(true);
    expect(w.owners.every((c) => /^\+9192020\d{5}$/.test(c.phone))).toBe(true);
    expect(w.partners.every((c) => /^\+9193030\d{5}$/.test(c.phone))).toBe(true);
    expect(w.consumers).toHaveLength(1000);
    for (const c of w.consumers) {
      expect(c.addresses.length).toBeGreaterThanOrEqual(1);
      expect(c.addresses.length).toBeLessThanOrEqual(3);
      expect(c.addresses[0]!.label).toBe('Home');
      expect(c.addresses.every((a) => a.locality && a.formattedAddress.includes(a.locality))).toBe(true);
      if (c.avatarKey) expect(c.avatarKey).toContain(c.gender === 'male' ? '/men/' : '/women/');
    }
    expect(w.partners).toHaveLength(250);
    expect(w.partners.filter((p) => p.status === 'APPROVED').length).toBeGreaterThan(200);
    for (const p of w.partners) expect(p.vehicle.registrationNumber).toMatch(p.vehicle.type === 'BICYCLE' ? /^NA-BICYCLE-\d{3}$/ : /^KA\d{2}[A-Z]{2}\d{4}$/);
  });

  it('history: ~5,000 checkouts over 60 days, lunch/dinner peaks, ~85% delivered, all in the past', () => {
    expect(w.checkouts).toHaveLength(5000);
    const children = w.checkouts.flatMap((c) => c.children);
    const delivered = children.filter((c) => c.outcome.kind === 'DELIVERED').length / children.length;
    expect(delivered).toBeGreaterThan(0.82);
    expect(delivered).toBeLessThan(0.9);
    expect(w.checkouts.some((c) => c.children.length === 2)).toBe(true);
    const oldest = Math.min(...w.checkouts.map((c) => c.placedAt.getTime()));
    expect((ANCHOR.getTime() - oldest) / 86_400_000).toBeGreaterThan(58);
    for (const c of w.checkouts) {
      for (const ch of c.children) {
        const last = ch.timeline.deliveredAt ?? ch.timeline.refundSucceededAt!;
        expect(last.getTime()).toBeLessThanOrEqual(ANCHOR.getTime());
        if (ch.rating) expect(ch.outcome.kind).toBe('DELIVERED');
        if (ch.outcome.kind === 'DELIVERED') expect(ch.partner?.status).toBe('APPROVED');
      }
    }
    const hour = (h0: number, h1: number) => w.checkouts.filter((c) => { const m = istMinuteOfDay(c.placedAt); return m >= h0 * 60 && m < h1 * 60; }).length;
    expect(hour(12, 15)).toBeGreaterThan(hour(15, 18) * 1.5);
    expect(hour(19, 23)).toBeGreaterThan(hour(15, 18) * 1.5);
    expect(hour(3, 6)).toBeLessThan(w.checkouts.length * 0.02);
    expect(w.checkouts.filter((c) => c.placedAt.getTime() >= w.at(0, 0).getTime()).length).toBeGreaterThan(0); // some of today
  });

  it('ratings: restaurant sums match; ~20% of approved restaurants stay "New" (under 5)', () => {
    const agg = new Map<string, [number, number]>();
    for (const ch of w.checkouts.flatMap((c) => c.children)) if (ch.rating) {
      const a = agg.get(ch.restaurant.id) ?? [0, 0];
      agg.set(ch.restaurant.id, [a[0] + ch.rating.stars, a[1] + 1]);
    }
    for (const r of w.restaurants) expect([r.ratingSum, r.ratingCount]).toEqual(agg.get(r.id) ?? [0, 0]);
    const approved = w.restaurants.filter((r) => r.status === 'APPROVED');
    const share = approved.filter((r) => r.ratingCount < 5).length / approved.length;
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.3);
  });

  it('coupons: city-wide + ~10% of restaurants scoped with a short badge; tickets for the admin badge', () => {
    const scoped = w.coupons.filter((c) => c.restaurantIds.length);
    const covered = new Set(scoped.flatMap((c) => c.restaurantIds)).size;
    expect(covered / w.restaurants.length).toBeGreaterThan(0.08);
    expect(covered / w.restaurants.length).toBeLessThan(0.13);
    expect(scoped.every((c) => c.badgeLabel && c.badgeLabel.length <= 16 && /OFF$/.test(c.badgeLabel))).toBe(true);
    expect(w.coupons.filter((c) => !c.restaurantIds.length).length).toBeGreaterThanOrEqual(3);
    expect(new Set(w.coupons.map((c) => c.code)).size).toBe(w.coupons.length);
    expect(w.tickets.filter((t) => t.status === 'OPEN')).toHaveLength(12);
    expect(w.tickets.filter((t) => t.status === 'IN_PROGRESS')).toHaveLength(8);
  });
});
