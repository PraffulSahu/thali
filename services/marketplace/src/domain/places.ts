/**
 * Address search, place lookup and reverse geocoding (MKT-1).
 *
 * Google (when the geo provider implements `autocomplete/placeDetails/reverse`) is tried first and
 * cached in Redis for 24 h (`geo:ac:<sha1(q|bias)>`, `geo:pd:<placeId>`, `geo:rev:<geohash-7>`). Any
 * provider failure (the adapter already records `google-places`/`google-geocode` with a scrubbed
 * message) falls back to the gazetteer — never a 5xx for a search or reverse lookup. Gazetteer results
 * are labelled `DEMO_GAZETTEER` (honest-data rule), or `FALLBACK` in production.
 * Gazetteer place ids are `gz_<localityId>` so they never collide with Google place ids.
 */
import { createHash } from 'node:crypto';
import { DomainError } from '@thali/contracts';
import { redisKey, type LatLng, type PlaceDetails, type PlaceSuggestion, type ReverseGeocodeResult } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import { geohash } from './geohash.js';
import { ensureGazetteer, gazetteerById, latLngOf, nearestLocality, searchGazetteer, type LocalityLean } from './localities.js';
import { findServiceArea } from './serviceability.js';

export type PlaceSource = 'GOOGLE' | 'DEMO_GAZETTEER' | 'FALLBACK';

const CACHE_TTL_SEC = 24 * 3600;
const GZ = 'gz_';

const gazetteerSource = (ctx: AppContext): PlaceSource => (ctx.config.APP_MODE === 'production' ? 'FALLBACK' : 'DEMO_GAZETTEER');

async function gazetteerReady(ctx: AppContext) {
  await ensureGazetteer(ctx.conn, { seedDataDir: ctx.config.SEED_DATA_DIR, production: ctx.config.APP_MODE === 'production', logger: ctx.logger });
}

async function cached<T>(ctx: AppContext, name: string, load: () => Promise<T>): Promise<T> {
  const key = redisKey(ctx.redis, name);
  try {
    const hit = await ctx.redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* cache is optional */
  }
  const value = await load();
  if (value !== null && value !== undefined) await ctx.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SEC).catch(() => undefined);
  return value;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

async function areaFor(ctx: AppContext, p: LatLng) {
  const a = await findServiceArea(ctx.conn, p);
  return { serviceable: !!a, serviceArea: a ? { id: String(a._id), name: a.name, minOrderPaise: a.minOrderPaise ?? 0 } : null };
}

function suggestionFromLocality(l: LocalityLean, source: PlaceSource) {
  const loc = latLngOf(l);
  return {
    id: `${GZ}${String(l._id)}`,
    primary: l.primary,
    secondary: l.kind === 'LOCALITY' ? [l.city, l.pincode].filter(Boolean).join(' ') : `${l.locality}, ${l.city}`,
    locality: l.locality,
    city: l.city,
    pincode: l.pincode ?? null,
    location: loc,
    source,
  };
}

const formatted = (l: LocalityLean) => `${l.kind === 'LOCALITY' ? l.name : `${l.primary}, ${l.locality}`}, ${l.city}${l.pincode ? ` ${l.pincode}` : ''}`;

export interface AutocompleteInput {
  q: string;
  lat?: number;
  lng?: number;
  limit: number;
  sessionToken?: string;
}

export async function autocompletePlaces(ctx: AppContext, input: AutocompleteInput) {
  const bias = input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : undefined;
  if (ctx.geo.autocomplete) {
    try {
      const biasKey = bias ? `${bias.lat.toFixed(2)},${bias.lng.toFixed(2)}` : '-';
      const items = await cached(ctx, `geo:ac:${sha1(`${input.q.trim().toLowerCase()}|${biasKey}`)}`, () =>
        ctx.geo.autocomplete!(input.q, { ...(bias ? { location: bias } : {}), ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}) }),
      );
      return { items: (items as PlaceSuggestion[]).slice(0, input.limit).map((s) => ({ ...s, source: 'GOOGLE' as const })), source: 'GOOGLE' as PlaceSource };
    } catch (err) {
      ctx.logger.warn({ err: (err as Error)?.message }, 'places autocomplete failed; using gazetteer');
    }
  }
  await gazetteerReady(ctx);
  const source = gazetteerSource(ctx);
  const rows = await searchGazetteer(ctx.conn, input.q, { bias, limit: input.limit });
  return { items: rows.map((l) => suggestionFromLocality(l, source)), source };
}

export async function placeDetails(ctx: AppContext, placeId: string, sessionToken?: string) {
  if (placeId.startsWith(GZ)) {
    await gazetteerReady(ctx);
    const l = await gazetteerById(ctx.conn, placeId.slice(GZ.length));
    if (!l) throw new DomainError('NOT_FOUND', 'Place not found');
    const location = latLngOf(l);
    return { id: placeId, formattedAddress: formatted(l), locality: l.locality, city: l.city, pincode: l.pincode ?? null, location, ...(await areaFor(ctx, location)), source: gazetteerSource(ctx) };
  }
  if (!ctx.geo.placeDetails) throw new DomainError('NOT_FOUND', 'Place not found');
  let d: PlaceDetails | null;
  try {
    d = await cached(ctx, `geo:pd:${sha1(placeId)}`, () => ctx.geo.placeDetails!(placeId, sessionToken ? { sessionToken } : undefined));
  } catch (err) {
    // a Google place id cannot be resolved without Google; the client should search again
    ctx.logger.warn({ err: (err as Error)?.message }, 'place details failed');
    throw new DomainError('UPSTREAM_UNAVAILABLE', 'Address lookup is unavailable right now; search again or drop a pin');
  }
  if (!d) throw new DomainError('NOT_FOUND', 'Place not found');
  return { id: d.id, formattedAddress: d.formattedAddress, locality: d.locality, city: d.city, pincode: d.pincode, location: d.location, ...(await areaFor(ctx, d.location)), source: 'GOOGLE' as PlaceSource };
}

export async function reverseGeocode(ctx: AppContext, p: LatLng) {
  const area = await areaFor(ctx, p);
  if (ctx.geo.reverse) {
    try {
      const r = await cached<ReverseGeocodeResult | null>(ctx, `geo:rev:${geohash(p.lat, p.lng, 7)}`, () => ctx.geo.reverse!(p));
      if (r) return { label: r.label, locality: r.locality, city: r.city, pincode: r.pincode, ...area, source: 'GOOGLE' as PlaceSource };
    } catch (err) {
      ctx.logger.warn({ err: (err as Error)?.message }, 'reverse geocode failed; using gazetteer');
    }
  }
  await gazetteerReady(ctx);
  const source = gazetteerSource(ctx);
  const l = await nearestLocality(ctx.conn, p, 3);
  if (!l) return { label: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, locality: null, city: null, pincode: null, ...area, source };
  return { label: `${l.name}, ${l.city}`, locality: l.locality, city: l.city, pincode: l.pincode ?? null, ...area, source };
}
