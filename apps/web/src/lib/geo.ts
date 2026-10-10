/**
 * Geo helpers. API/web shape is `{ lat, lng }` (`GeoPoint` from contracts); GeoJSON stays server-side.
 *
 *   haversineKm(a, b)                    -> distance in km (display only; server computes fees/ETAs)
 *   googleMapsDirectionsUrl(dest)        -> navigation deep link for partners (PRD D-5)
 *   isValidGeoPoint(p)                   -> type guard for untrusted input / storage
 */
import type { GeoPoint } from '@thali/contracts';

export type { GeoPoint };

/** Bengaluru city centre: initial map view before the user picks a location. */
export const DEFAULT_CENTER: GeoPoint = { lat: 12.9716, lng: 77.5946 };

export function isValidGeoPoint(p: unknown): p is GeoPoint {
  if (!p || typeof p !== 'object') return false;
  const { lat, lng } = p as Record<string, unknown>;
  return typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function googleMapsDirectionsUrl(dest: GeoPoint, origin?: GeoPoint): string {
  const params = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}` });
  if (origin) params.set('origin', `${origin.lat},${origin.lng}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Round for display / cache keys (5 dp ~ 1 m). */
export function roundGeo(p: GeoPoint, dp = 5): GeoPoint {
  const f = 10 ** dp;
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f };
}
