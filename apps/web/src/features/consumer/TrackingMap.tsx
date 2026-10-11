/**
 * Live delivery tracking for one child order (13-14, 13-16; PRD C-10): `GET /deliveries/tracking/:childOrderId`
 * (DLV-3 `remaining` ETA) plus `delivery.location` SSE updates merged into the query cache by OrderDetailPage.
 * Map = framed Leaflet map with the restaurant point (ORD-4), the rider and the drop pin; SIMULATED LOCATION only
 * when the payload says so; stale warning after 60 s.
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { Icon, MapFrame, MapPlaceholder, Skeleton } from '../../components/ui';
import type { MapMarker } from '../../components/ui/Map';
import { useNow } from '../../hooks/useNow';
import { fetchTracking, type TrackingView } from './api';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));

export const STALE_AFTER_SEC = 60;
export const trackingKey = (childId: string) => ['tracking', childId] as const;

export function useTracking(childId: string, enabled: boolean) {
  return useQuery({
    queryKey: trackingKey(childId),
    queryFn: () => fetchTracking(childId),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
  });
}

export function isStale(t: TrackingView | undefined, now: number): boolean {
  if (!t) return false;
  const last = t.lastLocationAt ? Date.parse(t.lastLocationAt) : null;
  return t.stale || (last !== null && now - last > STALE_AFTER_SEC * 1000);
}

export function TrackingMap({ tracking, restaurant, drop, restaurantName }: { tracking: TrackingView | undefined; restaurant: GeoPoint | null; drop: GeoPoint | null; restaurantName: string }) {
  const now = useNow(5000);
  const markers: MapMarker[] = [];
  if (restaurant) markers.push({ id: 'restaurant', position: restaurant, kind: 'restaurant', label: restaurantName });
  if (tracking?.location) markers.push({ id: 'partner', position: tracking.location, kind: 'partner', label: tracking.partner ? `${tracking.partner.firstName} (delivery partner)` : 'Delivery partner' });
  if (drop) markers.push({ id: 'home', position: drop, kind: 'home', label: 'Your address' });
  const center = tracking?.location ?? drop ?? restaurant;
  const simulated = !!tracking?.simulated;
  const aria = `Map showing ${tracking?.location ? 'the rider' : 'the route'} between ${restaurantName} and your address.${simulated ? ' Location is simulated.' : ''}`;
  const stale = isStale(tracking, now);
  return (
    <div className="relative">
      <MapFrame simulated={simulated} ariaLabel={aria}>
        {center ? (
          <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
            <MapView center={center} markers={markers} fitToMarkers={markers.length > 1} ariaLabel={aria} className="h-full" />
          </Suspense>
        ) : (
          <MapPlaceholder animate={false} />
        )}
      </MapFrame>
      {stale ? (
        <p role="status" className="absolute bottom-3 left-3.5 z-[400] inline-flex items-center gap-1.5 rounded-pill bg-warn-bg px-3 py-1.5 text-[12.5px] font-medium text-warn">
          <Icon name="alert" size={14} /> Location may be out of date
        </p>
      ) : null}
    </div>
  );
}
