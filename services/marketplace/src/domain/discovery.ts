/**
 * Public discovery (PRD C-1..C-4, context §3): only restaurants that can actually deliver to the drop
 * point — APPROVED, not paused, drop inside an ACTIVE service area, drop within the restaurant's
 * radius. Distance/ETA come from the GeoProvider and carry their source; fees from
 * `computeDeliveryFee`; ratings only from ≥ 5 real ratings (else null = "New"). Nothing is fabricated.
 */
import { DomainError } from '@thali/contracts';
import type { LatLng } from '@thali/service-kit';
import { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import type { MenuItemDoc } from '../models/menu-item.js';
import { isOpenAt } from './open-status.js';
import { ratingOf, type RestaurantLean } from './restaurant-view.js';
import { estimateDelivery, findServiceArea, isDeliverable, toLatLng, type ServiceArea } from './serviceability.js';

export const DISCOVERY_SORTS = ['distance', 'deliveryFee', 'eta', 'rating'] as const;
export type DiscoverySort = (typeof DISCOVERY_SORTS)[number];

export interface DiscoveryQuery {
  lat: number;
  lng: number;
  q?: string;
  /** true → pure-veg restaurants only */
  veg?: boolean;
  cuisine?: string[];
  priceBand?: number[];
  openNow?: boolean;
  sort?: DiscoverySort;
  cursor?: string;
  limit?: number;
}

type ItemLean = MenuItemDoc & { _id: Types.ObjectId };

/** Cost-for-one band from the average available item price: 1 < ₹200 ≤ 2 ≤ ₹400 < 3. */
export function priceBandOf(avgPaise: number): 1 | 2 | 3 {
  if (avgPaise < 20000) return 1;
  if (avgPaise <= 40000) return 2;
  return 3;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function encodeOffset(o: number) {
  return Buffer.from(JSON.stringify({ o }), 'utf8').toString('base64url');
}
function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: unknown };
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    /* fall through */
  }
  throw new DomainError('VALIDATION_FAILED', 'Invalid cursor', undefined, { issues: [{ path: 'query.cursor', message: 'Invalid cursor' }] });
}

function itemPublicView(ctx: AppContext, i: ItemLean) {
  const inStock = !i.trackStock || (i.stockQty ?? 0) - (i.reservedQty ?? 0) > 0;
  return {
    id: String(i._id),
    restaurantId: String(i.restaurantId),
    categoryId: String(i.categoryId),
    name: i.name,
    description: i.description ?? '',
    pricePaise: i.pricePaise,
    isVeg: i.isVeg,
    imageUrl: i.imageKey ? ctx.storage.publicUrl(i.imageKey) : null,
    available: !!i.available && inStock,
    customizationGroups: (i.customizationGroups ?? []).map((g) => ({
      id: String((g as { _id?: unknown })._id),
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: (g.options ?? []).map((o) => ({
        id: String((o as { _id?: unknown })._id),
        name: o.name,
        pricePaise: o.pricePaise,
        isVeg: o.isVeg,
        available: o.available !== false,
      })),
    })),
    tags: i.tags ?? [],
  };
}

const matchedItemView = (ctx: AppContext, i: ItemLean) => ({
  id: String(i._id),
  name: i.name,
  pricePaise: i.pricePaise,
  isVeg: i.isVeg,
  imageUrl: i.imageKey ? ctx.storage.publicUrl(i.imageKey) : null,
});

interface MenuStats {
  isVeg?: 'PURE_VEG' | 'MIXED';
  priceBand: 1 | 2 | 3 | null;
}

async function menuStats(ctx: AppContext, restaurantIds: Types.ObjectId[]): Promise<Map<string, MenuStats>> {
  const rows = await ctx.models.MenuItem.aggregate<{ _id: Types.ObjectId; nonVeg: number; avg: number; n: number }>([
    { $match: { restaurantId: { $in: restaurantIds }, available: true } },
    { $group: { _id: '$restaurantId', nonVeg: { $sum: { $cond: ['$isVeg', 0, 1] } }, avg: { $avg: '$pricePaise' }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, MenuStats>();
  for (const r of rows) out.set(String(r._id), { isVeg: r.nonVeg > 0 ? 'MIXED' : 'PURE_VEG', priceBand: priceBandOf(r.avg) });
  return out;
}

async function deliverableRestaurants(ctx: AppContext, drop: LatLng, area: ServiceArea, now: Date) {
  const candidates = await ctx.models.Restaurant.find({
    status: 'APPROVED',
    location: { $geoWithin: { $centerSphere: [[drop.lng, drop.lat], ctx.config.MAX_DELIVERY_RADIUS_KM / 6371] } },
  }).lean<RestaurantLean[]>();
  return candidates.filter((r) => {
    if (r.pausedUntil && new Date(r.pausedUntil).getTime() > now.getTime()) return false; // PRD C-2: not paused
    return isDeliverable(r, area, drop).deliverable;
  });
}

function compare(sort: DiscoverySort) {
  type Row = { distanceKm: number; deliveryFeePaise: number; etaMinutes: number; rating: { average: number; count: number } | null; id: string };
  const tie = (a: Row, b: Row) => a.distanceKm - b.distanceKm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return (a: Row, b: Row) => {
    switch (sort) {
      case 'deliveryFee':
        return a.deliveryFeePaise - b.deliveryFeePaise || tie(a, b);
      case 'eta':
        return a.etaMinutes - b.etaMinutes || tie(a, b);
      case 'rating':
        if (a.rating && b.rating) return b.rating.average - a.rating.average || b.rating.count - a.rating.count || tie(a, b);
        if (a.rating) return -1;
        if (b.rating) return 1;
        return tie(a, b);
      default:
        return tie(a, b);
    }
  };
}

async function buildListing(ctx: AppContext, query: DiscoveryQuery, area: ServiceArea) {
  const drop = { lat: query.lat, lng: query.lng };
  const now = ctx.now();
  let restaurants = await deliverableRestaurants(ctx, drop, area, now);
  if (query.cuisine?.length) {
    const want = new Set(query.cuisine.map((c) => c.toLowerCase()));
    restaurants = restaurants.filter((r) => (r.cuisines ?? []).some((c) => want.has(c.toLowerCase())));
  }

  // text search: restaurant fields OR item names/tags (restaurants matched via items carry matchedItems)
  const matched = new Map<string, ItemLean[]>();
  const q = query.q?.trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    const items = await ctx.models.MenuItem.find({
      restaurantId: { $in: restaurants.map((r) => r._id as Types.ObjectId) },
      available: true,
      $or: [{ name: re }, { tags: re }],
    })
      .sort({ name: 1 })
      .limit(500)
      .lean<ItemLean[]>();
    for (const i of items) {
      const k = String(i.restaurantId);
      if (!matched.has(k)) matched.set(k, []);
      if (matched.get(k)!.length < 5) matched.get(k)!.push(i);
    }
    restaurants = restaurants.filter(
      (r) => matched.has(String(r._id)) || re.test(r.name) || re.test(r.description ?? '') || (r.cuisines ?? []).some((c) => re.test(c)),
    );
  }

  const stats = await menuStats(ctx, restaurants.map((r) => r._id as Types.ObjectId));
  let rows = await Promise.all(
    restaurants.map(async (r) => {
      const id = String(r._id);
      const est = await estimateDelivery(ctx.geo, { location: r.location!, avgPrepMinutes: r.avgPrepMinutes }, area, drop);
      const open = isOpenAt(r, now);
      const s = stats.get(id) ?? { priceBand: null };
      return {
        id,
        slug: r.slug,
        name: r.name,
        cuisines: r.cuisines ?? [],
        imageUrl: r.images?.cover ? ctx.storage.publicUrl(r.images.cover) : null,
        ...(s.isVeg ? { isVeg: s.isVeg } : {}),
        open: open.open,
        ...(open.nextOpenAt ? { nextOpenAt: open.nextOpenAt.toISOString() } : {}),
        distanceKm: est.distanceKm,
        deliveryFeePaise: est.deliveryFeePaise,
        etaMinutes: est.etaMinutes,
        etaSource: est.etaSource,
        rating: ratingOf(r),
        priceBand: s.priceBand,
        isDemo: !!r.isDemo,
        ...(q ? { matchedItems: (matched.get(id) ?? []).map((i) => matchedItemView(ctx, i)) } : {}),
      };
    }),
  );
  if (query.veg) rows = rows.filter((r) => r.isVeg === 'PURE_VEG');
  if (query.priceBand?.length) rows = rows.filter((r) => r.priceBand !== null && query.priceBand!.includes(r.priceBand));
  if (query.openNow) rows = rows.filter((r) => r.open);
  rows.sort(compare(query.sort ?? 'distance'));
  return { rows, matched };
}

export type DiscoveryItem = Awaited<ReturnType<typeof buildListing>>['rows'][number];

const areaView = (a: ServiceArea) => ({ id: String(a._id), name: a.name, minOrderPaise: a.minOrderPaise ?? 0 });

export async function discoverRestaurants(ctx: AppContext, query: DiscoveryQuery) {
  const offset = decodeOffset(query.cursor);
  const limit = query.limit ?? 20;
  const area = await findServiceArea(ctx.conn, { lat: query.lat, lng: query.lng });
  if (!area) return { items: [] as DiscoveryItem[], nextCursor: null, serviceable: false, serviceArea: null };
  const { rows } = await buildListing(ctx, query, area);
  const page = rows.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor: offset + limit < rows.length ? encodeOffset(offset + limit) : null,
    serviceable: true,
    serviceArea: areaView(area),
  };
}

/** Combined search: deliverable restaurants matching `q` (with matchedItems) + a flat item list. */
export async function searchCatalog(ctx: AppContext, query: { lat: number; lng: number; q: string }) {
  const area = await findServiceArea(ctx.conn, query);
  if (!area) return { serviceable: false, restaurants: [] as DiscoveryItem[], items: [] };
  const { rows, matched } = await buildListing(ctx, { ...query, sort: 'distance' }, area);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const items = rows.flatMap((r) =>
    (matched.get(r.id) ?? []).map((i) => ({ ...matchedItemView(ctx, i), restaurantId: r.id, restaurantName: names.get(r.id)! })),
  );
  return { serviceable: true, restaurants: rows.slice(0, 50), items: items.slice(0, 50) };
}

export async function serviceability(ctx: AppContext, point: LatLng) {
  const area = await findServiceArea(ctx.conn, point);
  return { serviceable: !!area, area: area ? areaView(area) : null };
}

/** Public restaurant page (APPROVED only): profile, open status, optional delivery estimate, menu. */
export async function getPublicRestaurant(ctx: AppContext, idOrSlug: string, drop?: LatLng) {
  const filter = Types.ObjectId.isValid(idOrSlug) && /^[a-f0-9]{24}$/i.test(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() };
  const r = await ctx.models.Restaurant.findOne({ ...filter, status: 'APPROVED' }).lean<RestaurantLean>();
  if (!r) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  const now = ctx.now();
  const rid = r._id as Types.ObjectId;
  const [categories, items, stats] = await Promise.all([
    ctx.models.MenuCategory.find({ restaurantId: rid, active: true }).sort({ sortOrder: 1, _id: 1 }).lean(),
    ctx.models.MenuItem.find({ restaurantId: rid }).sort({ name: 1 }).lean<ItemLean[]>(),
    menuStats(ctx, [rid]),
  ]);
  const open = isOpenAt(r, now);

  let delivery = null;
  if (drop) {
    const area = await findServiceArea(ctx.conn, drop);
    const d = isDeliverable(r, area, drop);
    const paused = !!r.pausedUntil && new Date(r.pausedUntil).getTime() > now.getTime();
    if (d.deliverable && area && r.location) {
      const est = await estimateDelivery(ctx.geo, { location: r.location, avgPrepMinutes: r.avgPrepMinutes }, area, drop);
      delivery = { deliverable: !paused, ...(paused ? { reason: 'PAUSED' } : {}), ...est, minOrderPaise: area.minOrderPaise ?? 0 };
    } else {
      delivery = { deliverable: false, reason: d.reason, distanceKm: d.distanceKm };
    }
  }

  const s = stats.get(String(rid));
  return {
    restaurant: {
      id: String(rid),
      slug: r.slug,
      name: r.name,
      description: r.description ?? '',
      cuisines: r.cuisines ?? [],
      imageUrl: r.images?.cover ? ctx.storage.publicUrl(r.images.cover) : null,
      logoUrl: r.images?.logo ? ctx.storage.publicUrl(r.images.logo) : null,
      address: r.address ? { line1: r.address.line1, ...(r.address.line2 ? { line2: r.address.line2 } : {}), city: r.address.city, pincode: r.address.pincode } : null,
      location: r.location ? toLatLng(r.location) : null,
      hours: (r.hours ?? []).map((h) => ({ day: h.day, open: h.open, close: h.close })),
      timezone: r.timezone ?? 'Asia/Kolkata',
      open: open.open,
      ...(open.reason ? { closedReason: open.reason } : {}),
      ...(open.nextOpenAt ? { nextOpenAt: open.nextOpenAt.toISOString() } : {}),
      ...(s?.isVeg ? { isVeg: s.isVeg } : {}),
      priceBand: s?.priceBand ?? null,
      rating: ratingOf(r),
      packagingFeePaise: r.packagingFeePaise ?? 0,
      avgPrepMinutes: r.avgPrepMinutes ?? 20,
      isDemo: !!r.isDemo,
    },
    delivery,
    menu: categories.map((c) => ({
      id: String(c._id),
      name: c.name,
      sortOrder: c.sortOrder ?? 0,
      items: items.filter((i) => String(i.categoryId) === String(c._id)).map((i) => itemPublicView(ctx, i)),
    })),
  };
}

export { itemPublicView };
