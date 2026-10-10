/**
 * Geo helpers for dispatch/batching. Straight-line distances use haversine (service-kit); travel
 * time for batching uses the LLD 7 model: haversine × ROAD_FACTOR / AVG_SPEED_KMPH.
 * Distance/ETA stored on jobs comes from the configured GeoProvider (estimateSource recorded).
 */
import { haversineKm } from '@thali/service-kit';
import type { GeoJsonPoint } from '@thali/contracts';

export interface LatLng {
  lat: number;
  lng: number;
}

export { haversineKm };

const KM_PER_DEG_LAT = 111.195;

/** Point `northKm` / `eastKm` away from `from` (small-offset approximation; tests + simulator). */
export function offsetKm(from: LatLng, northKm: number, eastKm: number): LatLng {
  const lat = from.lat + northKm / KM_PER_DEG_LAT;
  const lng = from.lng + eastKm / (KM_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180));
  return { lat, lng };
}

export function toLatLng(p: GeoJsonPoint | { coordinates: number[] }): LatLng {
  const [lng, lat] = p.coordinates as [number, number];
  return { lat, lng };
}

export function toPoint(p: LatLng): GeoJsonPoint {
  return { type: 'Point', coordinates: [p.lng, p.lat] };
}

export interface TravelModel {
  roadFactor: number;
  avgSpeedKmph: number;
}

/** Minutes to travel a leg under the LLD 7 model (unrounded). */
export function legMinutes(a: LatLng, b: LatLng, m: TravelModel): number {
  return ((haversineKm(a, b) * m.roadFactor) / m.avgSpeedKmph) * 60;
}

/** Minutes to travel a route through `points` in order. */
export function routeMinutes(points: LatLng[], m: TravelModel): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += legMinutes(points[i - 1]!, points[i]!, m);
  return total;
}

/** Linear interpolation (simulator: straight line pickup → drop). */
export function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Google Maps directions link (partner navigation). */
export function mapsUrl(to: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=driving`;
}
