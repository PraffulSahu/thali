/**
 * In-memory MarketplaceClient fake. Implements LLD §8 quote / coupon / membership / reservation
 * semantics closely enough for orders tests: selection min/max + unknown/unavailable options →
 * INVALID_SELECTION, unavailable item → ITEM_UNAVAILABLE, stock → OUT_OF_STOCK, closed →
 * RESTAURANT_CLOSED, unserviceable drop → NOT_SERVICEABLE.
 */
import { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import type {
  CouponValidateRequest,
  CouponValidateResponse,
  InternalRestaurant,
  MarketplaceClient,
  MembershipBenefitsRequest,
  MembershipBenefitsResponse,
  QuoteLine,
  QuoteProblem,
  QuoteRequest,
  QuoteResponse,
  QuoteRestaurant,
  ReservationReleaseRequest,
  ReservationReleaseResponse,
  ReservationRequest,
  ReservationResponse,
} from '../../src/clients/marketplace.js';

export interface FakeOption {
  id: string;
  name: string;
  pricePaise: number;
  available: boolean;
}
export interface FakeGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: FakeOption[];
}
export interface FakeItem {
  id: string;
  restaurantId: string;
  name: string;
  isVeg: boolean;
  pricePaise: number;
  available: boolean;
  stockQty: number | null;
  groups: FakeGroup[];
}
export interface FakeRestaurant {
  id: string;
  name: string;
  ownerUserId: string;
  location: { lat: number; lng: number };
  address: { line1: string; line2?: string; locality?: string; city: string; pincode: string };
  phone: string;
  open: boolean;
  serviceable: boolean;
  deliveryFeePaise: number;
  packagingFeePaise: number;
  distanceKm: number;
  etaMinutes: number;
  commissionBps: number;
  avgPrepMinutes: number;
}

const oid = () => new Types.ObjectId().toHexString();

export class FakeMarketplace implements MarketplaceClient {
  restaurants = new Map<string, FakeRestaurant>();
  items = new Map<string, FakeItem>();
  /** `restaurantIds` (MKT-8 scope): empty/absent = every restaurant. */
  coupons = new Map<string, { discountPaise: number; restaurantIds?: string[]; perUserLimit?: number }>();
  /** Coupon holds taken by `reserve` (HELD redemptions count toward `perUserLimit`, like marketplace). */
  couponHolds: { checkoutId: string; userId: string; code: string }[] = [];
  /**
   * Whether a checkout's holds are still HELD. Marketplace releases them on `checkout.released`; tests
   * wire this to the orders DB (still AWAITING_PAYMENT) since the fake does not consume events.
   */
  isHoldLive: (checkoutId: string) => Promise<boolean> = async () => true;
  membership: MembershipBenefitsResponse | null = null;
  reserveCalls: ReservationRequest[] = [];
  quoteCalls: QuoteRequest[] = [];
  couponCalls: CouponValidateRequest[] = [];
  membershipCalls: MembershipBenefitsRequest[] = [];
  failReserveWith: Error | null = null;
  /** Return each restaurant's quote lines in reverse request order (lineRef must disambiguate). */
  reverseLines = false;
  /** Do not echo lineRef (legacy marketplace) — orders must fall back to position or fail closed. */
  omitLineRef = false;
  reserveDelayMs = 0;
  /** Synchronous supersede releases (I-2); `seqAtCall` = how many reserve calls had happened before. */
  releaseCalls: { checkoutId: string; userId: string; reason: string; seqAtCall: number }[] = [];
  /** Checkouts whose holds the synchronous release freed (the fake never consumes `checkout.released`). */
  releasedHolds = new Set<string>();
  failReleaseWith: Error | null = null;
  /** Runs inside `reserve` before it answers (race scenarios). */
  beforeReserve: ((req: ReservationRequest) => Promise<void>) | null = null;

  addRestaurant(over: Partial<FakeRestaurant> = {}): FakeRestaurant {
    const r: FakeRestaurant = {
      id: oid(),
      name: 'Restaurant',
      ownerUserId: oid(),
      location: { lat: 12.97, lng: 77.59 },
      address: { line1: '1 MG Road', city: 'Bengaluru', pincode: '560001' },
      phone: '+919876500000',
      open: true,
      serviceable: true,
      deliveryFeePaise: 3000,
      packagingFeePaise: 2000,
      distanceKm: 2.5,
      etaMinutes: 25,
      commissionBps: 1800,
      avgPrepMinutes: 20,
      ...over,
    };
    this.restaurants.set(r.id, r);
    return r;
  }

  addItem(restaurantId: string, over: Partial<FakeItem> = {}): FakeItem {
    const i: FakeItem = {
      id: oid(),
      restaurantId,
      name: 'Item',
      isVeg: true,
      pricePaise: 10000,
      available: true,
      stockQty: null,
      groups: [],
      ...over,
    };
    this.items.set(i.id, i);
    return i;
  }

  /** Two restaurants: A "Spice Route" (paneer w/ size + extras groups, dal) and B "Dosa Corner". */
  seedTwo() {
    const a = this.addRestaurant({ name: 'Spice Route', deliveryFeePaise: 3000, packagingFeePaise: 2000 });
    const b = this.addRestaurant({
      name: 'Dosa Corner',
      deliveryFeePaise: 4000,
      packagingFeePaise: 1000,
      location: { lat: 12.98, lng: 77.6 },
      address: { line1: '22 Church St', city: 'Bengaluru', pincode: '560002' },
    });
    const size: FakeGroup = {
      id: oid(),
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: oid(), name: 'Regular', pricePaise: 0, available: true },
        { id: oid(), name: 'Large', pricePaise: 3000, available: true },
      ],
    };
    const extras: FakeGroup = {
      id: oid(),
      name: 'Extras',
      minSelect: 0,
      maxSelect: 2,
      options: [
        { id: oid(), name: 'Cheese', pricePaise: 2000, available: true },
        { id: oid(), name: 'Mint chutney', pricePaise: 1000, available: true },
        { id: oid(), name: 'Truffle', pricePaise: 9000, available: false },
      ],
    };
    const paneer = this.addItem(a.id, { name: 'Paneer Tikka', pricePaise: 25000, groups: [size, extras] });
    const dal = this.addItem(a.id, { name: 'Dal Makhani', pricePaise: 25000 });
    const dosa = this.addItem(b.id, { name: 'Masala Dosa', pricePaise: 15000, isVeg: true });
    return { a, b, paneer, dal, dosa, size, extras };
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    this.quoteCalls.push(structuredClone(req));
    const problems: QuoteProblem[] = [];
    const byRestaurant = new Map<string, QuoteRestaurant>();
    for (const it of req.items) {
      const r = this.restaurants.get(it.restaurantId);
      const item = this.items.get(it.itemId);
      if (!r || !item || item.restaurantId !== it.restaurantId) {
        problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId: it.restaurantId, itemId: it.itemId, message: 'Item not found' });
        continue;
      }
      let qr = byRestaurant.get(r.id);
      if (!qr) {
        qr = {
          restaurantId: r.id,
          name: r.name,
          ownerUserId: r.ownerUserId,
          location: r.location,
          open: r.open,
          serviceable: req.drop ? r.serviceable : true,
          deliveryFeePaise: req.drop ? r.deliveryFeePaise : 0,
          distanceKm: r.distanceKm,
          etaMinutes: r.etaMinutes,
          etaSource: 'DEMO_HAVERSINE',
          packagingFeePaise: r.packagingFeePaise,
          lines: [],
        };
        byRestaurant.set(r.id, qr);
        if (!r.open) problems.push({ code: 'RESTAURANT_CLOSED', restaurantId: r.id, message: `${r.name} is closed` });
        if (req.drop && !r.serviceable)
          problems.push({ code: 'NOT_SERVICEABLE', restaurantId: r.id, message: `${r.name} does not deliver here` });
      }
      const addOns: QuoteLine['addOns'] = [];
      let selectionProblem: string | null = null;
      const chosen = new Map(it.selections.map((s) => [s.groupId, s.optionIds]));
      for (const gid of chosen.keys()) {
        if (!item.groups.some((g) => g.id === gid)) selectionProblem = 'Unknown customization group';
      }
      for (const g of item.groups) {
        const ids = chosen.get(g.id) ?? [];
        if (ids.length < g.minSelect || ids.length > g.maxSelect) selectionProblem = `${g.name}: choose ${g.minSelect}-${g.maxSelect}`;
        for (const id of ids) {
          const o = g.options.find((x) => x.id === id);
          if (!o) selectionProblem = `${g.name}: unknown option`;
          else if (!o.available) selectionProblem = `${g.name}: ${o.name} is unavailable`;
          else addOns.push({ id: o.id, name: o.name, pricePaise: o.pricePaise });
        }
      }
      if (selectionProblem) problems.push({ code: 'INVALID_SELECTION', restaurantId: r.id, itemId: item.id, message: selectionProblem });
      const stockOk = item.stockQty === null || item.stockQty >= it.quantity;
      if (!item.available) problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId: r.id, itemId: item.id, message: `${item.name} unavailable` });
      else if (!stockOk) problems.push({ code: 'OUT_OF_STOCK', restaurantId: r.id, itemId: item.id, message: `${item.name} out of stock` });
      qr.lines.push({
        ...(it.lineRef !== undefined && !this.omitLineRef ? { lineRef: it.lineRef } : {}),
        itemId: item.id,
        name: item.name,
        isVeg: item.isVeg,
        unitPricePaise: item.pricePaise,
        addOns,
        available: item.available,
        stockOk,
      });
    }
    if (this.reverseLines) for (const r of byRestaurant.values()) r.lines.reverse();
    return { restaurants: [...byRestaurant.values()], problems };
  }

  async validateCoupon(req: CouponValidateRequest): Promise<CouponValidateResponse> {
    this.couponCalls.push(req);
    const c = this.coupons.get(req.code.toUpperCase());
    if (!c) throw new DomainError('COUPON_INVALID', 'Coupon is not valid', 422);
    if (c.perUserLimit !== undefined) {
      // like marketplace: the user's live (HELD) holds count, except those of excluded (superseded) checkouts
      const excluded = new Set(req.excludeCheckoutIds ?? []);
      let held = 0;
      for (const hld of this.couponHolds) {
        if (hld.userId === req.userId && hld.code === req.code.toUpperCase() && !excluded.has(hld.checkoutId) && (await this.isHoldLive(hld.checkoutId))) held++;
      }
      if (held >= c.perUserLimit) throw new DomainError('COUPON_LIMIT_REACHED', 'You have already used this coupon', 422, { reason: 'PER_USER_LIMIT' });
    }
    const scope = c.restaurantIds ?? [];
    let eligible = req.itemsSubtotalPaise;
    if (scope.length && req.restaurantSubtotals) {
      eligible = req.restaurantSubtotals.filter((r) => scope.includes(r.restaurantId)).reduce((s, r) => s + r.subtotalPaise, 0);
      if (!req.restaurantSubtotals.some((r) => scope.includes(r.restaurantId))) {
        throw new DomainError('COUPON_INVALID', 'This coupon does not apply to these restaurants', 422, { reason: 'NOT_APPLICABLE', restaurantIds: [...scope] });
      }
    }
    return { code: req.code.toUpperCase(), discountPaise: Math.min(c.discountPaise, eligible), restaurantIds: [...scope], badgeLabel: null };
  }

  async membershipBenefits(req: MembershipBenefitsRequest): Promise<MembershipBenefitsResponse> {
    this.membershipCalls.push(req);
    return this.membership ?? { membershipId: null, freeDeliveryRestaurantIds: [], extraDiscountBps: 0, extraDiscountCapPaise: 0 };
  }

  async reserve(req: ReservationRequest): Promise<ReservationResponse> {
    this.reserveCalls.push(structuredClone(req));
    if (this.reserveDelayMs) await new Promise((r) => setTimeout(r, this.reserveDelayMs));
    if (this.beforeReserve) await this.beforeReserve(req);
    if (req.couponCode) {
      const code = req.couponCode.toUpperCase();
      const limit = this.coupons.get(code)?.perUserLimit;
      if (limit !== undefined) {
        let held = 0;
        for (const hld of this.couponHolds) {
          if (hld.userId === req.userId && hld.code === code && hld.checkoutId !== req.checkoutId && (await this.isHoldLive(hld.checkoutId))) held++;
        }
        if (held >= limit) throw new DomainError('COUPON_LIMIT_REACHED', 'You have already used this coupon', 422);
      }
      this.couponHolds.push({ checkoutId: req.checkoutId, userId: req.userId, code });
    }
    if (this.failReserveWith) throw this.failReserveWith;
    return { checkoutId: req.checkoutId, status: 'HELD', expiresAt: new Date(Date.now() + req.ttlSec * 1000).toISOString() };
  }

  async releaseReservation(req: ReservationReleaseRequest): Promise<ReservationReleaseResponse> {
    this.releaseCalls.push({ ...req, seqAtCall: this.reserveCalls.length });
    if (this.failReleaseWith) throw this.failReleaseWith;
    const known = this.reserveCalls.some((r) => r.checkoutId === req.checkoutId);
    const released = known && !this.releasedHolds.has(req.checkoutId);
    if (known) this.releasedHolds.add(req.checkoutId);
    return { checkoutId: req.checkoutId, released, status: known ? 'RELEASED' : 'MISSING' };
  }

  async getRestaurant(id: string): Promise<InternalRestaurant | null> {
    const r = this.restaurants.get(id);
    if (!r) return null;
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: r.name,
      status: 'APPROVED',
      location: r.location,
      address: r.address,
      phone: r.phone,
      commissionBps: r.commissionBps,
      packagingFeePaise: r.packagingFeePaise,
      avgPrepMinutes: r.avgPrepMinutes,
    };
  }
}
