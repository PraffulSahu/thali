/** 🔓 Discovery, search and serviceability (PRD C-1..C-3). */
import { z } from 'zod';
import { rateLimit, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { DISCOVERY_SORTS, discoverRestaurants, searchCatalog, serviceability } from '../domain/discovery.js';
import { autocompletePlaces, placeDetails, reverseGeocode } from '../domain/places.js';
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
const SessionToken = z.string().trim().min(1).max(100).optional().describe('Places session token (Google billing session: autocomplete calls + one details call)');
const PlacesQuery = z.object({
  q: z.string().trim().min(2).max(100),
  lat: z.coerce.number().min(-90).max(90).optional().describe('Bias point (optional, with lng)'),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(8),
  sessionToken: SessionToken,
});
const PlaceParams = z.object({ placeId: z.string().trim().min(1).max(300) });
const PlaceSource = z.enum(['GOOGLE', 'DEMO_GAZETTEER', 'FALLBACK']).describe('DEMO_GAZETTEER/FALLBACK = our own locality list (label it in the UI)');
const PlaceSuggestionView = z
  .object({
    id: z.string().describe('Pass to /discovery/places/:placeId'),
    primary: z.string(),
    secondary: z.string(),
    locality: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }).nullable().describe('Null for Google suggestions (resolve with details)'),
    source: PlaceSource,
  })
  .meta({ id: 'PlaceSuggestion' });

const MatchedItem = z.object({ id: z.string(), name: z.string(), pricePaise: z.number(), isVeg: z.boolean(), imageUrl: z.string().nullable() });
export const DiscoveryItemView = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    cuisines: z.array(z.string()),
    locality: z.string().nullable().describe('Neighbourhood, e.g. "Indiranagar" (MKT-5)'),
    imageUrl: z.string().nullable(),
    isVeg: z.enum(['PURE_VEG', 'MIXED']).describe('PURE_VEG only when the restaurant declared pureVeg (MKT-4)'),
    open: z.boolean().describe('Within hours and not paused'),
    nextOpenAt: z.string().optional(),
    closedReason: z.enum(['PAUSED', 'OUTSIDE_HOURS']).nullable().describe('PAUSED = "Not accepting orders" (MKT-3); null when open'),
    pausedUntil: z.string().nullable(),
    acceptingOrders: z.boolean().describe('An order can be placed right now (= open)'),
    closesAt: z.string().nullable().describe('End of the current open period (overnight aware); null when closed or open around the clock (MKT-12)'),
    distanceKm: z.number().describe('Road distance estimate (haversine × road factor)'),
    deliveryFeePaise: z.number().int(),
    etaMinutes: z.number().int().describe('avgPrepMinutes + travel estimate'),
    etaSource: z.enum(['GOOGLE', 'DEMO_HAVERSINE', 'HAVERSINE_FALLBACK']).describe('Listing estimates are haversine (DEMO_HAVERSINE in demo, HAVERSINE_FALLBACK in production) — label them EST.'),
    rating: RatingView,
    priceBand: z.number().int().min(1).max(3).nullable(),
    isDemo: z.boolean(),
    offer: z
      .object({ label: z.string().describe('e.g. "20% OFF"'), code: z.string() })
      .nullable()
      .describe('Best live restaurant-scoped coupon (MKT-8); null = no badge'),
    matchedItems: z.array(MatchedItem).optional().describe('Present when q is given'),
  })
  .meta({ id: 'DiscoveryRestaurant' });
const AreaView = z.object({ id: z.string(), name: z.string(), minOrderPaise: z.number().int() }).meta({ id: 'ServiceAreaSummary' });
const Counts = z
  .object({ total: z.number().int(), open: z.number().int() })
  .describe('MKT-2: after q/veg/price/cuisine filters, before openNow and pagination ("4 open now · 6 deliver here")');
const Facets = z
  .object({ cuisines: z.array(z.object({ slug: z.string(), count: z.number().int() })) })
  .describe('MKT-11: restaurants per cuisine slug after q/veg/price filters (cuisine and openNow filters not applied)');

const AreaRef = z.object({ id: z.string(), name: z.string(), minOrderPaise: z.number().int() });
const PlaceDetailsView = z
  .object({
    id: z.string(),
    formattedAddress: z.string(),
    locality: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }),
    serviceable: z.boolean(),
    serviceArea: AreaRef.nullable(),
    source: PlaceSource,
  })
  .meta({ id: 'PlaceDetails' });
const ReverseView = z
  .object({
    label: z.string().describe('"12th Main Rd, Indiranagar" (Google) / "Indiranagar, Bengaluru" (gazetteer) / "lat, lng" when nothing is near'),
    locality: z.string().nullable(),
    city: z.string().nullable(),
    pincode: z.string().nullable(),
    serviceable: z.boolean(),
    serviceArea: AreaRef.nullable(),
    source: PlaceSource,
  })
  .meta({ id: 'ReverseGeocode' });

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

    // MKT-1: address search / place lookup / reverse geocoding
    const vPlaces = validate({ query: PlacesQuery });
    r.get(`${D}/places`, limiter, vPlaces, async (req, res) => {
      res.json(await autocompletePlaces(ctx, vPlaces.get(req).query));
    });
    const vPlace = validate({ params: PlaceParams, query: z.object({ sessionToken: SessionToken }) });
    r.get(`${D}/places/:placeId`, limiter, vPlace, async (req, res) => {
      const { params, query } = vPlace.get(req);
      res.json(await placeDetails(ctx, params.placeId, query.sessionToken));
    });
    r.get(`${D}/reverse`, limiter, vPoint, async (req, res) => {
      res.json(await reverseGeocode(ctx, vPoint.get(req).query));
    });
  },
  openapi(api) {
    const tags = ['discovery'];
    api.route({
      method: 'get', path: `${D}/restaurants`, tags, rateLimited: true,
      summary: 'Restaurants that deliver to the drop point (APPROVED, drop in an active service area and within the restaurant radius). Paused restaurants are listed with closedReason PAUSED; open restaurants sort first.',
      request: { query: DiscoveryQuery },
      responses: {
        200: {
          description: 'Deliverable restaurants. Drop outside every active area → { items: [], serviceable: false }.',
          content: json(z.object({ items: z.array(DiscoveryItemView), nextCursor: z.string().nullable(), serviceable: z.boolean(), serviceArea: AreaView.nullable(), counts: Counts, facets: Facets })),
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
    api.route({
      method: 'get', path: `${D}/places`, tags, rateLimited: true,
      summary: 'Address autocomplete (Google Places when configured, else / on failure the locality gazetteer)',
      request: { query: PlacesQuery },
      responses: { 200: { description: 'Suggestions', content: json(z.object({ items: z.array(PlaceSuggestionView), source: PlaceSource })) } },
    });
    api.route({
      method: 'get', path: `${D}/places/:placeId`, tags, rateLimited: true,
      summary: 'Resolve a suggestion to coordinates + serviceability. 502 UPSTREAM_UNAVAILABLE only for a Google id while Google is down.',
      request: { params: PlaceParams, query: z.object({ sessionToken: SessionToken }) },
      responses: { 200: { description: 'Place', content: json(PlaceDetailsView) } },
      errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'],
    });
    api.route({
      method: 'get', path: `${D}/reverse`, tags, rateLimited: true,
      summary: 'Label a point ("Use my location") + serviceability. Never fails on a provider outage (gazetteer fallback, 3 km).',
      request: { query: LatLngQuery },
      responses: { 200: { description: 'Reverse geocode', content: json(ReverseView) } },
    });
  },
};
