/** 🔓 Discovery, search and serviceability (PRD C-1..C-3). */
import { z } from 'zod';
import { rateLimit, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { DISCOVERY_SORTS, discoverRestaurants, searchCatalog, serviceability } from '../domain/discovery.js';
import { API, boolQuery, json, splitCsv, LatLngQuery, RatingView } from './common.js';

const DiscoveryQuery = LatLngQuery.extend({
  q: z.string().trim().max(100).optional(),
  veg: boolQuery.describe('true → pure-veg restaurants only'),
  cuisine: z.string().max(500).optional().transform(splitCsv).pipe(z.array(z.string().max(40)).optional()).describe('CSV of cuisine slugs'),
  priceBand: z.string().max(20).optional().transform((v) => splitCsv(v)?.map(Number)).pipe(z.array(z.number().int().min(1).max(3)).optional()).describe('CSV of 1|2|3 (avg item price < ₹200, ₹200–400, > ₹400)'),
  openNow: boolQuery,
  sort: z.enum(DISCOVERY_SORTS).default('distance'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const SearchQuery = LatLngQuery.extend({ q: z.string().trim().min(1).max(100) });

const MatchedItem = z.object({ id: z.string(), name: z.string(), pricePaise: z.number(), isVeg: z.boolean(), imageUrl: z.string().nullable() });
export const DiscoveryItemView = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    cuisines: z.array(z.string()),
    imageUrl: z.string().nullable(),
    isVeg: z.enum(['PURE_VEG', 'MIXED']).optional(),
    open: z.boolean(),
    nextOpenAt: z.string().optional(),
    distanceKm: z.number().describe('Road distance estimate from the geo provider'),
    deliveryFeePaise: z.number().int(),
    etaMinutes: z.number().int().describe('avgPrepMinutes + travel estimate'),
    etaSource: z.enum(['GOOGLE', 'DEMO_HAVERSINE', 'HAVERSINE_FALLBACK']).describe('DEMO_HAVERSINE = demo estimate (label it in the UI)'),
    rating: RatingView,
    priceBand: z.number().int().min(1).max(3).nullable(),
    isDemo: z.boolean(),
    matchedItems: z.array(MatchedItem).optional().describe('Present when q is given'),
  })
  .meta({ id: 'DiscoveryRestaurant' });
const AreaView = z.object({ id: z.string(), name: z.string(), minOrderPaise: z.number().int() }).meta({ id: 'ServiceAreaSummary' });

const D = `${API}/discovery`;

export const discoveryRoutes: RouteModule = {
  name: 'discovery',
  register(r, ctx) {
    // LLD 5.4: search 60/min per IP (coarse, fails open if Redis is down)
    const limiter = rateLimit({ redis: ctx.redis, name: 'discovery', keyFn: (req) => req.ip ?? 'unknown', points: 60, durationSec: 60, failOpen: true });

    const vList = validate({ query: DiscoveryQuery });
    r.get(`${D}/restaurants`, limiter, vList, async (req, res) => {
      res.json(await discoverRestaurants(ctx, vList.get(req).query));
    });
    const vSearch = validate({ query: SearchQuery });
    r.get(`${D}/search`, limiter, vSearch, async (req, res) => {
      res.json(await searchCatalog(ctx, vSearch.get(req).query));
    });
    const vPoint = validate({ query: LatLngQuery });
    r.get(`${D}/serviceability`, limiter, vPoint, async (req, res) => {
      res.json(await serviceability(ctx, vPoint.get(req).query));
    });
  },
  openapi(api) {
    const tags = ['discovery'];
    api.route({
      method: 'get', path: `${D}/restaurants`, tags, rateLimited: true,
      summary: 'Restaurants that deliver to the drop point (APPROVED, not paused, drop in an active service area and within the restaurant radius)',
      request: { query: DiscoveryQuery },
      responses: {
        200: {
          description: 'Deliverable restaurants. Drop outside every active area → { items: [], serviceable: false }.',
          content: json(z.object({ items: z.array(DiscoveryItemView), nextCursor: z.string().nullable(), serviceable: z.boolean(), serviceArea: AreaView.nullable() })),
        },
      },
    });
    api.route({
      method: 'get', path: `${D}/search`, tags, rateLimited: true, summary: 'Search deliverable restaurants and menu items',
      request: { query: SearchQuery },
      responses: {
        200: {
          description: 'Matches',
          content: json(z.object({ serviceable: z.boolean(), restaurants: z.array(DiscoveryItemView), items: z.array(MatchedItem.extend({ restaurantId: z.string(), restaurantName: z.string() })) })),
        },
      },
    });
    api.route({
      method: 'get', path: `${D}/serviceability`, tags, rateLimited: true, summary: 'Is this point inside an active service area?',
      request: { query: LatLngQuery },
      responses: { 200: { description: 'Serviceability', content: json(z.object({ serviceable: z.boolean(), area: AreaView.nullable() })) } },
    });
  },
};
