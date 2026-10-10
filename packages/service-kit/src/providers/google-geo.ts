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
 *  - Autocomplete (MKT-1): Places API (New) `POST https://places.googleapis.com/v1/places:autocomplete`,
 *    header `X-Goog-Api-Key`, body `{ input, includedRegionCodes: ['in'], sessionToken?, locationBias?: {
 *    circle: { center: { latitude, longitude }, radius } } }` → `{ suggestions: [{ placePrediction: {
 *    placeId, text: { text }, structuredFormat: { mainText: { text }, secondaryText: { text } } } }] }`.
 *  - Place details: Places API (New) `GET https://places.googleapis.com/v1/places/{placeId}?sessionToken=`,
 *    headers `X-Goog-Api-Key`, `X-Goog-FieldMask: id,formattedAddress,location,addressComponents` →
 *    `{ id, formattedAddress, location: { latitude, longitude }, addressComponents: [{ longText, shortText, types }] }`.
 *  - Reverse: Geocoding API `GET .../geocode/json?latlng=<lat>,<lng>&key=&region=in`.
 *  These three never fall back silently: on failure they record a provider error (`google-places` /
 *  `google-geocode`, with the error message) and throw `UPSTREAM_UNAVAILABLE`; the caller falls back.
 */
import type { AppMode, ServiceName } from '@thali/contracts';
import { DomainError } from '@thali/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { recordProviderError } from '../health-details.js';
import { roadEstimate, type GeoProvider, type LatLng, type RoadEstimateOptions } from './geo.js';
import { fetchJson, ProviderError } from './http.js';

export const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const GOOGLE_ROUTES_FIELD_MASK = 'routes.duration,routes.distanceMeters';
export const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export const GOOGLE_PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
export const GOOGLE_PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
export const GOOGLE_PLACE_DETAILS_FIELD_MASK = 'id,formattedAddress,location,addressComponents';
/** Default autocomplete bias radius (m). */
const DEFAULT_BIAS_RADIUS_M = 30_000;
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
  /** Overrides the redis-based recorder (tests). `err` is the failure; its message is what gets recorded. */
  recordError?: (provider: string, err: unknown) => Promise<void>;
  logger?: Logger;
  /** Geocoding region bias. Default `in`. */
  region?: string;
}

interface RoutesResponse {
  routes?: { distanceMeters?: number; duration?: string }[];
}
interface GeocodeComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}
interface GeocodeResponse {
  status?: string;
  results?: {
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: GeocodeComponent[];
  }[];
}
interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }[];
}
interface PlaceResponse {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
}

interface AddressParts {
  route: string | null;
  locality: string | null;
  city: string | null;
  pincode: string | null;
}

/** Map Google address components (either API's naming) to locality / city / pincode / route. */
function addressParts(components: { long?: string; short?: string; types?: string[] }[]): AddressParts {
  const find = (type: string) => components.find((c) => c.types?.includes(type));
  const long = (type: string) => find(type)?.long || null;
  return {
    route: find('route')?.short || long('route'),
    locality: long('sublocality_level_1') ?? long('sublocality') ?? long('neighborhood'),
    city: long('locality') ?? long('administrative_area_level_2'),
    pincode: long('postal_code'),
  };
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createGoogleGeo(opts: GoogleGeoOptions): GeoProvider {
  if (!opts.apiKey) throw new Error('createGoogleGeo: apiKey is required');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const travelMode = opts.travelMode ?? 'TWO_WHEELER';
  const fallbackSource = opts.mode === 'production' ? 'HAVERSINE_FALLBACK' : 'DEMO_HAVERSINE';
  const record =
    opts.recordError ??
    (opts.redis && opts.service
      ? (provider: string, err: unknown) => recordProviderError(opts.redis!, opts.service!, provider, Date.now(), errMessage(err))
      : undefined);
  const region = opts.region ?? 'in';
  const unavailable = (what: string) => new DomainError('UPSTREAM_UNAVAILABLE', `${what} is unavailable`);

  async function failed(provider: string, err: unknown): Promise<void> {
    opts.logger?.warn({ err: errMessage(err), provider }, 'geo provider failed');
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
      url.searchParams.set('region', region);
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
    async autocomplete(query, bias = {}) {
      const req: Record<string, unknown> = { input: query, includedRegionCodes: [region] };
      if (bias.sessionToken) req.sessionToken = bias.sessionToken;
      if (bias.location) {
        req.locationBias = {
          circle: { center: { latitude: bias.location.lat, longitude: bias.location.lng }, radius: bias.radiusM ?? DEFAULT_BIAS_RADIUS_M },
        };
      }
      let body: AutocompleteResponse;
      try {
        body = await fetchJson<AutocompleteResponse>('google-places', GOOGLE_PLACES_AUTOCOMPLETE_URL, {
          method: 'POST',
          timeoutMs,
          headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': opts.apiKey },
          body: JSON.stringify(req),
        });
      } catch (err) {
        await failed('google-places', err);
        throw unavailable('Address search');
      }
      const out = [];
      for (const s of body.suggestions ?? []) {
        const p = s.placePrediction;
        if (!p?.placeId) continue; // query predictions have no place
        out.push({
          id: p.placeId,
          primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
          secondary: p.structuredFormat?.secondaryText?.text ?? '',
          locality: null,
          city: null,
          pincode: null,
          location: null,
        });
      }
      return out;
    },
    async placeDetails(placeId, o = {}) {
      const url = new URL(`${GOOGLE_PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`);
      if (o.sessionToken) url.searchParams.set('sessionToken', o.sessionToken);
      let body: PlaceResponse;
      try {
        body = await fetchJson<PlaceResponse>('google-places', url.toString(), {
          timeoutMs,
          headers: { 'X-Goog-Api-Key': opts.apiKey, 'X-Goog-FieldMask': GOOGLE_PLACE_DETAILS_FIELD_MASK },
        });
      } catch (err) {
        // unknown (404) or malformed (400 INVALID_ARGUMENT) place id is caller input, not a provider fault
        if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) return null;
        await failed('google-places', err);
        throw unavailable('Place lookup');
      }
      const lat = body.location?.latitude;
      const lng = body.location?.longitude;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        await failed('google-places', new Error('place has no location'));
        throw unavailable('Place lookup');
      }
      const parts = addressParts((body.addressComponents ?? []).map((c) => ({ long: c.longText, short: c.shortText, types: c.types })));
      return {
        id: body.id ?? placeId,
        formattedAddress: body.formattedAddress ?? '',
        locality: parts.locality,
        city: parts.city,
        pincode: parts.pincode,
        location: { lat, lng },
      };
    },
    async reverse(point: LatLng) {
      const url = new URL(GOOGLE_GEOCODE_URL);
      url.searchParams.set('latlng', `${point.lat},${point.lng}`);
      url.searchParams.set('key', opts.apiKey);
      url.searchParams.set('region', region);
      let body: GeocodeResponse;
      try {
        body = await fetchJson<GeocodeResponse>('google-geocode', url.toString(), { timeoutMs });
      } catch (err) {
        await failed('google-geocode', err);
        throw unavailable('Reverse geocoding');
      }
      if (body.status === 'ZERO_RESULTS') return null;
      const r = body.results?.[0];
      if (body.status !== 'OK' || !r) {
        await failed('google-geocode', new Error(`status ${body.status}`));
        throw unavailable('Reverse geocoding');
      }
      const parts = addressParts((r.address_components ?? []).map((c) => ({ long: c.long_name, short: c.short_name, types: c.types })));
      const formattedAddress = r.formatted_address ?? '';
      const loc = r.geometry?.location;
      const label =
        parts.route && parts.locality
          ? `${parts.route}, ${parts.locality}`
          : parts.locality && parts.city
            ? `${parts.locality}, ${parts.city}`
            : formattedAddress.split(',').slice(0, 2).join(',').trim() || parts.route || parts.locality || formattedAddress;
      return {
        label,
        formattedAddress,
        locality: parts.locality,
        city: parts.city,
        pincode: parts.pincode,
        location: typeof loc?.lat === 'number' && typeof loc?.lng === 'number' ? { lat: loc.lat, lng: loc.lng } : point,
      };
    },
  };
}
