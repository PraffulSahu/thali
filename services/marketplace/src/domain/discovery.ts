/**
 * Public discovery (PRD C-1..C-4, context §3): only restaurants that can actually deliver to the drop
 * point — APPROVED, drop inside an ACTIVE service area, drop within the restaurant's radius. Paused
 * restaurants are listed as "Not accepting orders" (`closedReason: 'PAUSED'`, ADR-34 — overrules PRD
 * C-2's "hidden"); quote/checkout still reject them (RESTAURANT_CLOSED). Fees from
 * `computeDeliveryFee`; ratings only from ≥ 5 real ratings (else null = "New"). Nothing is fabricated.
 *
 * Scale (MKT-13, ~600 restaurants / ~15k items):
 *  - candidates come from the `{status, location: 2dsphere}` index;
 *  - veg / price band come from the denormalised `restaurants.menuStats` (no per-request item `$group`);
 *  - list-time distance/ETA is a haversine road estimate (`roadEstimate`, labelled DEMO_HAVERSINE /
 *    HAVERSINE_FALLBACK) — the geo provider (Google) is only called for the restaurant page and quote;
 *  - item search uses the `menu_items` text index;
 *  - the ordered id list (+ counts, facets, matched item ids) is cached in Redis for
 *    `DISCOVERY_CACHE_TTL_SEC` (default 60) per (area, drop geohash-7, filters, epoch). Pages are
 *    hydrated fresh from Mongo (open status, rating, exact distance for the real drop point).
 */
import { createHash } from 'node:crypto';
import { DomainError } from '@thali/contracts';
import { computeDeliveryFee } from '@thali/pricing';
import { roadEstimate, type LatLng } from '@thali/service-kit';
import { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import type { MenuItemDoc } from '../models/menu-item.js';
import { discoveryEpoch } from './discovery-cache.js';
import { geohash } from './geohash.js';
import { computeMenuStats, emptyMenuStats, menuStatsFromItems, type MenuStats } from './menu-stats.js';
import { statusBlock } from './open-status.js';
import { ratingOf, type RestaurantLean } from './restaurant-view.js';
import { estimateDelivery, findServiceArea, isDeliverable, toLatLng, type ServiceArea } from './serviceability.js';

export { priceBandOf } from './menu-stats.js';

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
type Candidate = RestaurantLean & { _id: Types.ObjectId; menuStats?: MenuStats | null; pureVeg?: boolean | null };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

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

/** MKT-6: SOLD_OUT = toggled on but tracked stock exhausted; UNAVAILABLE = toggled off. */
function availabilityOf(i: Pick<ItemLean, 'available' | 'trackStock' | 'stockQty' | 'reservedQty'>) {
  const left = i.trackStock ? Math.max(0, (i.stockQty ?? 0) - (i.reservedQty ?? 0)) : null;
  const inStock = left === null || left > 0;
  const unavailableReason = !i.available ? ('UNAVAILABLE' as const) : !inStock ? ('SOLD_OUT' as const) : null;
  return { available: !!i.available && inStock, unavailableReason, stockLeft: left !== null && left <= 5 ? left : null };
}

function itemPublicView(ctx: AppContext, i: ItemLean) {
  return {
    id: String(i._id),
    restaurantId: String(i.restaurantId),
    categoryId: String(i.categoryId),
    name: i.name,
    description: i.description ?? '',
    pricePaise: i.pricePaise,
    isVeg: i.isVeg,
    imageUrl: ctx.imageUrl(i.imageKey),
    ...availabilityOf(i),
    featured: !!(i as { featured?: boolean }).featured,
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

const matchedItemView = (ctx: AppContext, i: Pick<ItemLean, '_id' | 'name' | 'pricePaise' | 'isVeg' | 'imageKey'>) => ({
  id: String(i._id),
  name: i.name,
  pricePaise: i.pricePaise,
  isVeg: i.isVeg,
  imageUrl: ctx.imageUrl(i.imageKey),
});

/**
 * MKT-4: the owner-declared `pureVeg` flag wins. Restaurants that never declared it (data from before
 * the flag) fall back to their whole menu: pure veg iff no item/option is non-veg (availability is
 * ignored, fixing the old "toggle the chicken off and become pure veg" bug). null = no menu yet.
 */
export function effectivePureVeg(r: { pureVeg?: boolean | null; menuStats?: Pick<MenuStats, 'itemCount' | 'nonVegCount'> | null }): boolean | null {
  if (typeof r.pureVeg === 'boolean') return r.pureVeg;
  if (!r.menuStats || !r.menuStats.itemCount) return null;
  return r.menuStats.nonVegCount === 0;
}

const vegField = (r: Candidate) => {
  const v = effectivePureVeg(r);
  return v === null ? {} : { isVeg: v ? ('PURE_VEG' as const) : ('MIXED' as const) };
};

/** Fields a listing never needs (keeps the candidate query light). */
const LIST_PROJECTION = { documents: 0, statusHistory: 0, settlement: 0, emailVerification: 0, emailVerificationLog: 0 } as const;

/** Fill `menuStats` for restaurants written before the field existed (persisted once, never overwrites). */
async function ensureMenuStats(ctx: AppContext, rows: Candidate[]) {
  const missing = rows.filter((r) => !r.menuStats?.updatedAt);
  if (!missing.length) return;
  const at = new Date();
  const stats = await computeMenuStats(ctx.conn, missing.map((r) => r._id), undefined, at);
  for (const r of missing) r.menuStats = stats.get(String(r._id)) ?? emptyMenuStats(at);
  await ctx.models.Restaurant.bulkWrite(
    missing.map((r) => ({ updateOne: { filter: { _id: r._id, 'menuStats.updatedAt': { $exists: false } }, update: { $set: { menuStats: r.menuStats } } } })),
    { ordered: false },
  ).catch((err: unknown) => ctx.logger.warn({ err }, 'menuStats self-heal write failed'));
}

async function deliverableCandidates(ctx: AppContext, drop: LatLng, area: ServiceArea): Promise<Candidate[]> {
  const rows = await ctx.models.Restaurant.find(
    {
      status: 'APPROVED',
      // restaurant must be inside the SAME active area that contains the drop, and near the drop
      $and: [
        { location: { $geoWithin: { $geometry: area.polygon } } },
        { location: { $geoWithin: { $centerSphere: [[drop.lng, drop.lat], ctx.config.MAX_DELIVERY_RADIUS_KM / 6371] } } },
      ],
    },
    LIST_PROJECTION,
  ).lean<Candidate[]>();
  const ok = rows.filter((r) => isDeliverable(r, area, drop).deliverable);
  await ensureMenuStats(ctx, ok);
  return ok;
}

/** List-time estimate: haversine × road factor (no provider call per candidate). */
function listEstimate(ctx: AppContext, r: Candidate, area: ServiceArea, drop: LatLng) {
  const est = roadEstimate(toLatLng(r.location!), drop, { roadFactor: ctx.config.ROAD_FACTOR, avgSpeedKmph: ctx.config.AVG_SPEED_KMPH });
  const etaSource = ctx.geo.name === 'demo' || ctx.config.APP_MODE !== 'production' ? ('DEMO_HAVERSINE' as const) : ('HAVERSINE_FALLBACK' as const);
  return {
    distanceKm: est.distanceKm,
    deliveryFeePaise: computeDeliveryFee(est.distanceKm, area.deliveryFee),
    etaMinutes: (r.avgPrepMinutes ?? 20) + est.etaMinutes,
    etaSource,
  };
}

function rowFor(ctx: AppContext, r: Candidate, area: ServiceArea, drop: LatLng, now: Date, matched?: ItemLean[]) {
  const id = String(r._id);
  const est = listEstimate(ctx, r, area, drop);
  const st = statusBlock(r, now);
  return {
    id,
    slug: r.slug,
    name: r.name,
    cuisines: r.cuisines ?? [],
    locality: r.address?.locality ?? null,
    imageUrl: ctx.imageUrl(r.images?.cover),
    ...vegField(r),
    open: st.open,
    ...(st.nextOpenAt ? { nextOpenAt: st.nextOpenAt.toISOString() } : {}),
    closedReason: st.closedReason === 'NOT_APPROVED' ? null : st.closedReason,
    pausedUntil: iso(st.pausedUntil),
    acceptingOrders: st.acceptingOrders,
    closesAt: iso(st.closesAt),
    ...est,
    rating: ratingOf(r),
    priceBand: (r.menuStats?.priceBand ?? null) as 1 | 2 | 3 | null,
    isDemo: !!r.isDemo,
    ...(matched ? { matchedItems: matched.map((i) => matchedItemView(ctx, i)) } : {}),
  };
}

export type DiscoveryItem = ReturnType<typeof rowFor>;

function compare(sort: DiscoverySort) {
  type Row = Pick<DiscoveryItem, 'distanceKm' | 'deliveryFeePaise' | 'etaMinutes' | 'rating' | 'id' | 'open'>;
  const tie = (a: Row, b: Row) => a.distanceKm - b.distanceKm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const by = (a: Row, b: Row) => {
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
  // MKT-3: open restaurants first, then the chosen order
  return (a: Row, b: Row) => (a.open === b.open ? by(a, b) : a.open ? -1 : 1);
}

/** Text-index item search (MKT-13). Whole words, stemmed; quotes and negations are stripped. */
async function searchItems(ctx: AppContext, restaurantIds: Types.ObjectId[], q: string): Promise<ItemLean[]> {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["\\]/g, '').replace(/^-+/, ''))
    .filter(Boolean);
  if (!terms.length || !restaurantIds.length) return [];
  return ctx.models.MenuItem.find(
    { $text: { $search: terms.join(' ') }, restaurantId: { $in: restaurantIds }, available: true },
    { score: { $meta: 'textScore' }, name: 1, restaurantId: 1, pricePaise: 1, isVeg: 1, imageKey: 1 },
  )
    .sort({ score: { $meta: 'textScore' }, name: 1 })
    .limit(500)
    .lean<ItemLean[]>();
}

interface Listing {
  ids: string[];
  counts: { total: number; open: number };
  facets: { cuisines: { slug: string; count: number }[] };
  /** restaurantId → matched item ids (≤ 5), only when q is given */
  matched: Record<string, string[]>;
}

interface ComputedListing extends Listing {
  rows: Map<string, DiscoveryItem>;
}

async function computeListing(ctx: AppContext, query: DiscoveryQuery, area: ServiceArea): Promise<ComputedListing> {
  const drop = { lat: query.lat, lng: query.lng };
  const now = ctx.now();
  let restaurants = await deliverableCandidates(ctx, drop, area);

  // text search: restaurant fields OR item names/tags (restaurants matched via items carry matchedItems)
  const matchedItems = new Map<string, ItemLean[]>();
  const q = query.q?.trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    for (const i of await searchItems(ctx, restaurants.map((r) => r._id), q)) {
      const k = String(i.restaurantId);
      if (!matchedItems.has(k)) matchedItems.set(k, []);
      if (matchedItems.get(k)!.length < 5) matchedItems.get(k)!.push(i);
    }
    restaurants = restaurants.filter(
      (r) => matchedItems.has(String(r._id)) || re.test(r.name) || re.test(r.description ?? '') || (r.cuisines ?? []).some((c) => re.test(c)),
    );
  }
  if (query.veg) restaurants = restaurants.filter((r) => effectivePureVeg(r) === true);
  if (query.priceBand?.length) restaurants = restaurants.filter((r) => r.menuStats?.priceBand != null && query.priceBand!.includes(r.menuStats.priceBand));

  // MKT-11: cuisine facets after q/veg/price, before the cuisine filter itself (so the carousel keeps every option)
  const facetCounts = new Map<string, number>();
  for (const r of restaurants) for (const c of new Set((r.cuisines ?? []).map((x) => x.toLowerCase()))) facetCounts.set(c, (facetCounts.get(c) ?? 0) + 1);
  const facets = { cuisines: [...facetCounts].map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : 1)) };

  if (query.cuisine?.length) {
    const want = new Set(query.cuisine.map((c) => c.toLowerCase()));
    restaurants = restaurants.filter((r) => (r.cuisines ?? []).some((c) => want.has(c.toLowerCase())));
  }

  let rows = restaurants.map((r) => rowFor(ctx, r, area, drop, now, q ? (matchedItems.get(String(r._id)) ?? []) : undefined));
  // MKT-2: totals after cuisine/veg/price/q, before openNow + pagination
  const counts = { total: rows.length, open: rows.filter((r) => r.open).length };
  if (query.openNow) rows = rows.filter((r) => r.open);
  rows.sort(compare(query.sort ?? 'distance'));

  const matched: Record<string, string[]> = {};
  if (q) for (const r of rows) matched[r.id] = (matchedItems.get(r.id) ?? []).map((i) => String(i._id));
  return { ids: rows.map((r) => r.id), counts, facets, matched, rows: new Map(rows.map((r) => [r.id, r])) };
}

function cacheKey(query: DiscoveryQuery, area: ServiceArea, epoch: string) {
  const filters = {
    q: query.q?.trim().toLowerCase().replace(/\s+/g, ' ') || null,
    veg: !!query.veg,
    cuisine: [...(query.cuisine ?? [])].map((c) => c.toLowerCase()).sort(),
    priceBand: [...(query.priceBand ?? [])].sort(),
    openNow: !!query.openNow,
    sort: query.sort ?? 'distance',
  };
  const h = createHash('sha1').update(JSON.stringify(filters)).digest('hex').slice(0, 20);
  return `disc:list:${epoch}:${String(area._id)}:${geohash(query.lat, query.lng, 7)}:${h}`;
}

/** Cached ordered listing; on a miss also returns the freshly built rows. Redis trouble → compute (fail open). */
async function getListing(ctx: AppContext, query: DiscoveryQuery, area: ServiceArea): Promise<Listing & { rows?: Map<string, DiscoveryItem> }> {
  const ttl = ctx.config.DISCOVERY_CACHE_TTL_SEC;
  if (!ttl) return computeListing(ctx, query, area);
  let key: string | null = null;
  try {
    key = cacheKey(query, area, await discoveryEpoch(ctx.redis));
    const hit = await ctx.redis.get(key);
    if (hit) return JSON.parse(hit) as Listing;
  } catch (err) {
    ctx.logger.warn({ err }, 'discovery cache read failed');
  }
  const fresh = await computeListing(ctx, query, area);
  if (key) {
    const { rows: _rows, ...cached } = fresh;
    await ctx.redis.set(key, JSON.stringify(cached), 'EX', ttl).catch((err: unknown) => ctx.logger.warn({ err }, 'discovery cache write failed'));
  }
  return fresh;
}

/** Rows for `ids` in order: from the fresh build, else re-read (dropping rows that no longer qualify). */
async function hydrate(ctx: AppContext, ids: string[], listing: Listing & { rows?: Map<string, DiscoveryItem> }, query: DiscoveryQuery, area: ServiceArea): Promise<DiscoveryItem[]> {
  if (!ids.length) return [];
  if (listing.rows) return ids.map((id) => listing.rows!.get(id)!).filter(Boolean);
  const drop = { lat: query.lat, lng: query.lng };
  const now = ctx.now();
  const oids = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const docs = await ctx.models.Restaurant.find({ _id: { $in: oids } }, LIST_PROJECTION).lean<Candidate[]>();
  await ensureMenuStats(ctx, docs);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  let items = new Map<string, ItemLean>();
  if (query.q?.trim()) {
    const itemIds = ids.flatMap((id) => listing.matched[id] ?? []).map((x) => new Types.ObjectId(x));
    const rows = itemIds.length
      ? await ctx.models.MenuItem.find({ _id: { $in: itemIds }, available: true }, { name: 1, restaurantId: 1, pricePaise: 1, isVeg: 1, imageKey: 1 }).lean<ItemLean[]>()
      : [];
    items = new Map(rows.map((i) => [String(i._id), i]));
  }
  const out: DiscoveryItem[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.status !== 'APPROVED' || !isDeliverable(r, area, drop).deliverable) continue;
    const matched = query.q?.trim() ? (listing.matched[id] ?? []).map((x) => items.get(x)).filter((x): x is ItemLean => !!x) : undefined;
    const row = rowFor(ctx, r, area, drop, now, matched);
    if (query.openNow && !row.open) continue;
    out.push(row);
  }
  return out;
}

const areaView = (a: ServiceArea) => ({ id: String(a._id), name: a.name, minOrderPaise: a.minOrderPaise ?? 0 });

export async function discoverRestaurants(ctx: AppContext, query: DiscoveryQuery) {
  const offset = decodeOffset(query.cursor);
  const limit = query.limit ?? 20;
  const area = await findServiceArea(ctx.conn, { lat: query.lat, lng: query.lng });
  if (!area) {
    return { items: [] as DiscoveryItem[], nextCursor: null, serviceable: false, serviceArea: null, counts: { total: 0, open: 0 }, facets: { cuisines: [] as { slug: string; count: number }[] } };
  }
  const listing = await getListing(ctx, query, area);
  const items = await hydrate(ctx, listing.ids.slice(offset, offset + limit), listing, query, area);
  return {
    items,
    nextCursor: offset + limit < listing.ids.length ? encodeOffset(offset + limit) : null,
    serviceable: true,
    serviceArea: areaView(area),
    counts: listing.counts,
    facets: listing.facets,
  };
}

/** Combined search: deliverable restaurants matching `q` (with matchedItems) + a flat item list. */
export async function searchCatalog(ctx: AppContext, query: { lat: number; lng: number; q: string }) {
  const area = await findServiceArea(ctx.conn, query);
  if (!area) return { serviceable: false, restaurants: [] as DiscoveryItem[], items: [] };
  const q = { ...query, sort: 'distance' as const };
  const listing = await getListing(ctx, q, area);
  const rows = await hydrate(ctx, listing.ids.slice(0, 50), listing, q, area);
  const items = rows.flatMap((r) => (r.matchedItems ?? []).map((i) => ({ ...i, restaurantId: r.id, restaurantName: r.name })));
  return { serviceable: true, restaurants: rows, items: items.slice(0, 50) };
}

export async function serviceability(ctx: AppContext, point: LatLng) {
  const area = await findServiceArea(ctx.conn, point);
  return { serviceable: !!area, area: area ? areaView(area) : null };
}

/** Public restaurant page (APPROVED only): profile, open status, optional delivery estimate, menu. */
export async function getPublicRestaurant(ctx: AppContext, idOrSlug: string, drop?: LatLng) {
  const filter = Types.ObjectId.isValid(idOrSlug) && /^[a-f0-9]{24}$/i.test(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() };
  const r = await ctx.models.Restaurant.findOne({ ...filter, status: 'APPROVED' }).lean<Candidate>();
  if (!r) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  const now = ctx.now();
  const rid = r._id as Types.ObjectId;
  const [categories, items] = await Promise.all([
    ctx.models.MenuCategory.find({ restaurantId: rid, active: true }).sort({ sortOrder: 1, _id: 1 }).lean(),
    ctx.models.MenuItem.find({ restaurantId: rid }).sort({ name: 1 }).lean<ItemLean[]>(),
  ]);
  const st = statusBlock(r, now);
  const stats = menuStatsFromItems(items, now);

  let delivery = null;
  if (drop) {
    const area = await findServiceArea(ctx.conn, drop);
    const d = isDeliverable(r, area, drop);
    const paused = st.closedReason === 'PAUSED';
    if (d.deliverable && area && r.location) {
      const est = await estimateDelivery(ctx.geo, { location: r.location, avgPrepMinutes: r.avgPrepMinutes }, area, drop);
      delivery = { deliverable: !paused, ...(paused ? { reason: 'PAUSED' } : {}), ...est, minOrderPaise: area.minOrderPaise ?? 0 };
    } else {
      delivery = { deliverable: false, reason: d.reason, distanceKm: d.distanceKm };
    }
  }

  const activeCats = new Set(categories.map((c) => String(c._id)));
  const pureVeg = effectivePureVeg({ pureVeg: r.pureVeg, menuStats: stats });
  // MKT-9: owner-featured dishes from active categories, available first
  const recommended = items
    .filter((i) => (i as { featured?: boolean }).featured && activeCats.has(String(i.categoryId)))
    .map((i) => itemPublicView(ctx, i))
    .sort((a, b) => Number(b.available) - Number(a.available) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    restaurant: {
      id: String(rid),
      slug: r.slug,
      name: r.name,
      description: r.description ?? '',
      cuisines: r.cuisines ?? [],
      imageUrl: ctx.imageUrl(r.images?.cover),
      logoUrl: ctx.imageUrl(r.images?.logo),
      address: r.address
        ? { line1: r.address.line1, ...(r.address.line2 ? { line2: r.address.line2 } : {}), ...(r.address.locality ? { locality: r.address.locality } : {}), city: r.address.city, pincode: r.address.pincode }
        : null,
      locality: r.address?.locality ?? null,
      location: r.location ? toLatLng(r.location) : null,
      hours: (r.hours ?? []).map((h) => ({ day: h.day, open: h.open, close: h.close })),
      timezone: r.timezone ?? 'Asia/Kolkata',
      open: st.open,
      ...(st.closedReason ? { closedReason: st.closedReason } : {}),
      ...(st.nextOpenAt ? { nextOpenAt: st.nextOpenAt.toISOString() } : {}),
      pausedUntil: iso(st.pausedUntil),
      acceptingOrders: st.acceptingOrders,
      closesAt: iso(st.closesAt),
      ...(pureVeg === null ? {} : { isVeg: pureVeg ? ('PURE_VEG' as const) : ('MIXED' as const) }),
      pureVeg: pureVeg === true,
      priceBand: stats.priceBand,
      rating: ratingOf(r),
      packagingFeePaise: r.packagingFeePaise ?? 0,
      avgPrepMinutes: r.avgPrepMinutes ?? 20,
      isDemo: !!r.isDemo,
    },
    delivery,
    recommended,
    menu: categories.map((c) => ({
      id: String(c._id),
      name: c.name,
      sortOrder: c.sortOrder ?? 0,
      items: items.filter((i) => String(i.categoryId) === String(c._id)).map((i) => itemPublicView(ctx, i)),
    })),
  };
}

export { itemPublicView };
