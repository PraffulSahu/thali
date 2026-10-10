/**
 * Serviceability (PRD C-2): "nearby" ≠ "deliverable". A drop point is serviceable only inside an
 * ACTIVE service area polygon; a restaurant delivers there only if it is APPROVED and the drop is
 * within its `deliveryRadiusKm` (straight-line). Open/paused state is separate (`open-status.ts`), so
 * callers can distinguish RESTAURANT_CLOSED from NOT_SERVICEABLE.
 */
import type { Connection } from 'mongoose';
import { computeDeliveryFee } from '@thali/pricing';
import { haversineKm, type GeoProvider, type LatLng } from '@thali/service-kit';
import { serviceAreaModel, type ServiceAreaDoc } from '../models/service-area.js';

export type ServiceArea = ServiceAreaDoc & { _id: unknown };

export interface DeliverabilityInput {
  status: string;
  location?: { coordinates: number[] } | null;
  deliveryRadiusKm?: number | null;
}

export type NotDeliverableReason = 'NO_SERVICE_AREA' | 'NOT_APPROVED' | 'NO_LOCATION' | 'OUTSIDE_SERVICE_AREA' | 'OUTSIDE_RADIUS';

export interface Deliverability {
  deliverable: boolean;
  /** Straight-line km from restaurant to drop (null when the restaurant has no location). */
  distanceKm: number | null;
  reason?: NotDeliverableReason;
}

export const DEFAULT_DELIVERY_RADIUS_KM = 6;

/** The active service area whose polygon contains the point (first by creation when overlapping). */
export async function findServiceArea(conn: Connection, point: LatLng): Promise<ServiceArea | null> {
  return serviceAreaModel(conn)
    .findOne({
      active: true,
      polygon: { $geoIntersects: { $geometry: { type: 'Point', coordinates: [point.lng, point.lat] } } },
    })
    .sort({ createdAt: 1, _id: 1 })
    .lean<ServiceArea>();
}

export const toLatLng = (loc: { coordinates: number[] }): LatLng => ({ lat: loc.coordinates[1]!, lng: loc.coordinates[0]! });

/** Ray-casting test on one ring of [lng, lat] positions (planar; fine at city scale). */
function inRing(ring: number[][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lng < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** Point inside a GeoJSON Polygon (outer ring, excluding holes). */
export function pointInPolygon(polygon: { coordinates: number[][][] }, p: LatLng): boolean {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer || !inRing(outer, p.lng, p.lat)) return false;
  return !holes.some((h) => inRing(h, p.lng, p.lat));
}

/**
 * Deliverable iff the drop's active area exists, the restaurant is APPROVED, the restaurant itself is
 * inside that SAME area polygon, and the drop is within the restaurant's radius.
 */
export function isDeliverable(restaurant: DeliverabilityInput, area: ServiceArea | null, drop: LatLng): Deliverability {
  const distanceKm = restaurant.location?.coordinates?.length === 2 ? Math.round(haversineKm(toLatLng(restaurant.location), drop) * 100) / 100 : null;
  if (!area) return { deliverable: false, distanceKm, reason: 'NO_SERVICE_AREA' };
  if (restaurant.status !== 'APPROVED') return { deliverable: false, distanceKm, reason: 'NOT_APPROVED' };
  if (distanceKm === null) return { deliverable: false, distanceKm, reason: 'NO_LOCATION' };
  if (!pointInPolygon(area.polygon as unknown as { coordinates: number[][][] }, toLatLng(restaurant.location!))) return { deliverable: false, distanceKm, reason: 'OUTSIDE_SERVICE_AREA' };
  const radius = restaurant.deliveryRadiusKm ?? DEFAULT_DELIVERY_RADIUS_KM;
  if (distanceKm > radius) return { deliverable: false, distanceKm, reason: 'OUTSIDE_RADIUS' };
  return { deliverable: true, distanceKm };
}

export interface DeliveryEstimate {
  /** Road distance from the geo provider (km). */
  distanceKm: number;
  deliveryFeePaise: number;
  /** avgPrepMinutes + travel minutes. */
  etaMinutes: number;
  etaSource: 'GOOGLE' | 'DEMO_HAVERSINE' | 'HAVERSINE_FALLBACK';
}

/**
 * Fee + ETA for a deliverable restaurant (LLD 6 "Delivery fee per child"): distance from the geo
 * provider, fee via `computeDeliveryFee` with the drop's service-area rule. Estimates are labelled
 * with their source (`DEMO_HAVERSINE` in demo) — never fabricated.
 */
export async function estimateDelivery(
  geo: GeoProvider,
  restaurant: { location: { coordinates: number[] }; avgPrepMinutes?: number | null },
  area: ServiceArea,
  drop: LatLng,
): Promise<DeliveryEstimate> {
  const est = await geo.distanceAndEta(toLatLng(restaurant.location), drop);
  return {
    distanceKm: est.distanceKm,
    deliveryFeePaise: computeDeliveryFee(est.distanceKm, area.deliveryFee),
    etaMinutes: (restaurant.avgPrepMinutes ?? 20) + est.etaMinutes,
    etaSource: est.source,
  };
}
