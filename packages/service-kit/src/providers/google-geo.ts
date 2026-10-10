/**
 * Google GeoProvider.
 *  - Distance/ETA: Routes API `POST https://routes.googleapis.com/directions/v2:computeRoutes` with
 *    headers `X-Goog-Api-Key`, `X-Goog-FieldMask: routes.duration,routes.distanceMeters`; body
 *    `{ origin|destination: { location: { latLng: { latitude, longitude } } }, travelMode, units: 'METRIC' }`.
 *    Response `{ routes: [{ distanceMeters: 772, duration: "165s" }] }` (verified against
 *    developers.google.com/maps/documentation/routes/compute_route_directions, 2026-10-10).
 *    Default travelMode `TWO_WHEELER` (two-wheeler routing is supported in India per Google's coverage page).
 *  - On any failure (timeout 5 s, HTTP error, no route): records a provider error and returns the
 *    haversine estimate labelled `DEMO_HAVERSINE` in demo/sandbox and `HAVERSINE_FALLBACK` in
 *    production — never labelled `GOOGLE`.
 *  - Geocode: Geocoding API `GET https://maps.googleapis.com/maps/api/geocode/json?address=&key=&region=in`.
 */
import type { AppMode, ServiceName } from '@thali/contracts';
import { DomainError } from '@thali/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { recordProviderError } from '../health-details.js';
import { roadEstimate, type GeoProvider, type RoadEstimateOptions } from './geo.js';
import { fetchJson } from './http.js';

export const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const GOOGLE_ROUTES_FIELD_MASK = 'routes.duration,routes.distanceMeters';
export const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export type GoogleTravelMode = 'TWO_WHEELER' | 'DRIVE';

export interface GoogleGeoOptions extends RoadEstimateOptions {
  apiKey: string;
  mode: AppMode;
  /** Default `TWO_WHEELER`. */
  travelMode?: GoogleTravelMode;
  /** Default 5000 ms. */
  timeoutMs?: number;
  /** With `service`, failures are recorded via `recordProviderError(redis, service, provider)`. */
  redis?: Redis;
  service?: ServiceName;
  /** Overrides the redis-based recorder (tests). */
  recordError?: (provider: string, err: unknown) => Promise<void>;
  logger?: Logger;
  /** Geocoding region bias. Default `in`. */
  region?: string;
}

interface RoutesResponse {
  routes?: { distanceMeters?: number; duration?: string }[];
}
interface GeocodeResponse {
  status?: string;
  results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[];
}

export function createGoogleGeo(opts: GoogleGeoOptions): GeoProvider {
  if (!opts.apiKey) throw new Error('createGoogleGeo: apiKey is required');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const travelMode = opts.travelMode ?? 'TWO_WHEELER';
  const fallbackSource = opts.mode === 'production' ? 'HAVERSINE_FALLBACK' : 'DEMO_HAVERSINE';
  const record =
    opts.recordError ??
    (opts.redis && opts.service ? (provider: string) => recordProviderError(opts.redis!, opts.service!, provider) : undefined);

  async function failed(provider: string, err: unknown): Promise<void> {
    opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), provider }, 'geo provider failed');
    try {
      await record?.(provider, err);
    } catch (e) {
      opts.logger?.warn({ err: e }, 'could not record provider error');
    }
  }

  return {
    name: 'google',
    async distanceAndEta(from, to) {
      try {
        const body = await fetchJson<RoutesResponse>('google-routes', GOOGLE_ROUTES_URL, {
          method: 'POST',
          timeoutMs,
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': opts.apiKey,
            'X-Goog-FieldMask': GOOGLE_ROUTES_FIELD_MASK,
          },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
            destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
            travelMode,
            units: 'METRIC',
          }),
        });
        const route = body.routes?.[0];
        const seconds = route?.duration !== undefined ? Number.parseFloat(String(route.duration).replace(/s$/, '')) : NaN;
        // an empty route ({}) means "no route found"; distanceMeters may be omitted only for 0 m
        if (!route || !Number.isFinite(seconds)) throw new Error('no route in response');
        const meters = Number(route.distanceMeters ?? 0);
        return {
          distanceKm: Math.round(meters / 10) / 100,
          etaMinutes: Math.ceil(seconds / 60),
          source: 'GOOGLE',
        };
      } catch (err) {
        await failed('google-routes', err);
        return { ...roadEstimate(from, to, opts), source: fallbackSource };
      }
    },
    async geocode(query) {
      const url = new URL(GOOGLE_GEOCODE_URL);
      url.searchParams.set('address', query);
      url.searchParams.set('key', opts.apiKey);
      url.searchParams.set('region', opts.region ?? 'in');
      let body: GeocodeResponse;
      try {
        body = await fetchJson<GeocodeResponse>('google-geocode', url.toString(), { timeoutMs });
      } catch (err) {
        await failed('google-geocode', err);
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'Geocoding is unavailable');
      }
      if (body.status === 'ZERO_RESULTS') return null;
      const r = body.results?.[0];
      const loc = r?.geometry?.location;
      if (body.status !== 'OK' || !r || typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') {
        await failed('google-geocode', new Error(`status ${body.status}`));
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'Geocoding is unavailable');
      }
      return { lat: loc.lat, lng: loc.lng, formattedAddress: r.formatted_address ?? query };
    },
  };
}
