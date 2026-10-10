/**
 * GeoProvider port (HLD 6): distance + ETA between two points, optional geocoding.
 * Every estimate carries `source` (LLD 3.5 `estimateSource`): `GOOGLE` | `DEMO_HAVERSINE` (demo
 * estimate, demo/sandbox only) | `HAVERSINE_FALLBACK` (production fallback when Google failed).
 */
import type { AppMode, EstimateSource, ServiceName } from '@thali/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ConfigError } from '../config.js';
import { createDemoGeo } from './demo-geo.js';
import { createGoogleGeo, type GoogleTravelMode } from './google-geo.js';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DistanceEta {
  /** Road distance, km, 2 decimals. */
  distanceKm: number;
  /** Whole minutes, rounded up. */
  etaMinutes: number;
  source: EstimateSource;
}

export interface GeocodeResult extends LatLng {
  formattedAddress: string;
}

/** Autocomplete bias (MKT-1). */
export interface AutocompleteBias {
  /** Bias results around this point. */
  location?: LatLng;
  /** Bias circle radius in metres (Google max 50000). Default 30000 when `location` is set. */
  radiusM?: number;
  /** Places session token (groups autocomplete + one details call into one billed session). */
  sessionToken?: string;
}

/** One autocomplete suggestion. Google fills `id/primary/secondary`; the rest may be null until `placeDetails`. */
export interface PlaceSuggestion {
  /** Provider place id (Google `placeId`). */
  id: string;
  /** e.g. "12th Main Rd". */
  primary: string;
  /** e.g. "Indiranagar, Bengaluru, Karnataka, India" ('' when the provider gives none). */
  secondary: string;
  locality: string | null;
  city: string | null;
  pincode: string | null;
  location: LatLng | null;
}

/** A resolved place (MKT-1 `GET /discovery/places/:placeId`). */
export interface PlaceDetails {
  id: string;
  formattedAddress: string;
  /** Neighbourhood (sublocality_level_1 → sublocality → neighborhood). */
  locality: string | null;
  /** City (locality → administrative_area_level_2). */
  city: string | null;
  pincode: string | null;
  location: LatLng;
}

/** Reverse-geocode result (MKT-1 `GET /discovery/reverse`). */
export interface ReverseGeocodeResult {
  /** Short label, e.g. "12th Main Rd, Indiranagar" (route + locality, else locality + city, else the formatted address). */
  label: string;
  formattedAddress: string;
  locality: string | null;
  city: string | null;
  pincode: string | null;
  location: LatLng;
}

export interface GeoProvider {
  readonly name: 'google' | 'demo';
  distanceAndEta(from: LatLng, to: LatLng): Promise<DistanceEta>;
  /** Google only; `null` when nothing matched. */
  geocode?(query: string): Promise<GeocodeResult | null>;
  /**
   * Google only (demo leaves it undefined → marketplace uses its gazetteer). `[]` when nothing matched.
   * Provider failure: records `google-places` and throws `DomainError('UPSTREAM_UNAVAILABLE')`.
   */
  autocomplete?(query: string, bias?: AutocompleteBias): Promise<PlaceSuggestion[]>;
  /** Google only. `null` for an unknown place id (404). Failure: records `google-places`, throws `UPSTREAM_UNAVAILABLE`. */
  placeDetails?(placeId: string, opts?: { sessionToken?: string }): Promise<PlaceDetails | null>;
  /** Google only. `null` for ZERO_RESULTS. Failure: records `google-geocode`, throws `UPSTREAM_UNAVAILABLE`. */
  reverse?(point: LatLng): Promise<ReverseGeocodeResult | null>;
}

/** LLD 7 defaults. */
export const ROAD_FACTOR = 1.3;
export const AVG_SPEED_KMPH = 20;
const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RoadEstimateOptions {
  roadFactor?: number;
  avgSpeedKmph?: number;
}

/** haversine × roadFactor (rounded to 0.01 km); eta = ceil(distance / speed × 60) from the rounded distance. */
export function roadEstimate(from: LatLng, to: LatLng, opts: RoadEstimateOptions = {}): { distanceKm: number; etaMinutes: number } {
  const roadFactor = opts.roadFactor ?? ROAD_FACTOR;
  const speed = opts.avgSpeedKmph ?? AVG_SPEED_KMPH;
  const distanceKm = Math.round(haversineKm(from, to) * roadFactor * 100) / 100;
  return { distanceKm, etaMinutes: Math.ceil((distanceKm / speed) * 60) };
}

export interface GeoProviderConfig {
  GEO_PROVIDER: 'google' | 'demo';
  APP_MODE: AppMode;
  SERVICE_NAME: ServiceName;
  GOOGLE_MAPS_API_KEY?: string;
  ROAD_FACTOR?: number;
  AVG_SPEED_KMPH?: number;
  GOOGLE_TRAVEL_MODE?: GoogleTravelMode;
}

/**
 * Pick the adapter from config. Throws `ConfigError` for `demo` in production or `google` without a key.
 * Pass `redis` so Google failures are counted by `recordProviderError` (admin health).
 */
export function createGeoProvider(config: GeoProviderConfig, deps: { redis?: Redis; logger?: Logger } = {}): GeoProvider {
  const road = { roadFactor: config.ROAD_FACTOR, avgSpeedKmph: config.AVG_SPEED_KMPH };
  if (config.GEO_PROVIDER === 'demo') {
    if (config.APP_MODE === 'production') throw new ConfigError(['GEO_PROVIDER: demo geo provider is not allowed in production']);
    return createDemoGeo(road);
  }
  if (!config.GOOGLE_MAPS_API_KEY) throw new ConfigError(['GOOGLE_MAPS_API_KEY: required when GEO_PROVIDER=google']);
  return createGoogleGeo({
    apiKey: config.GOOGLE_MAPS_API_KEY,
    mode: config.APP_MODE,
    service: config.SERVICE_NAME,
    redis: deps.redis,
    logger: deps.logger,
    travelMode: config.GOOGLE_TRAVEL_MODE,
    ...road,
  });
}
