/**
 * Live delivery tracking for one child order (PRD C-10): `GET /deliveries/tracking/:childOrderId` plus
 * `delivery.location` SSE updates (merged into the query cache by OrderDetailPage). Shows partner first name +
 * vehicle, a partner marker, "updated Xs ago", a stale warning after 60 s and the SIMULATED label.
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { Badge, Icon, RelativeTime, Skeleton } from '../../components/ui';
import type { MapMarker } from '../../components/ui/Map';
import { useNow } from '../../hooks/useNow';
import { isNotFound } from '../../lib/errors';
import { humanize } from '../../components/ui/StatusPill';
import { fetchTracking, type TrackingView } from './api';
import { EtaText } from './parts';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));

export const STALE_AFTER_SEC = 60;
export const trackingKey = (childId: string) => ['tracking', childId] as const;

export function useTracking(childId: string, enabled: boolean) {
  return useQuery({
    queryKey: trackingKey(childId),
    queryFn: () => fetchTracking(childId),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function TrackingMap({ childId, drop, enabled = true }: { childId: string; drop?: GeoPoint | null; enabled?: boolean }) {
  const tracking = useTracking(childId, enabled);
  const now = useNow(1000);

  if (tracking.isPending) return <Skeleton className="h-48 w-full" />;
  if (tracking.isError) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-600">
        <Icon name="bike" size={16} />
        {isNotFound(tracking.error) ? 'Finding a delivery partner…' : "Live tracking isn't available right now. We'll keep trying."}
      </p>
    );
  }
  const t: TrackingView = tracking.data;
  const lastAt = t.lastLocationAt ? Date.parse(t.lastLocationAt) : null;
  const stale = t.stale || (lastAt !== null && now - lastAt > STALE_AFTER_SEC * 1000);
  const markers: MapMarker[] = [];
  if (t.location) markers.push({ id: 'partner', position: t.location, kind: 'partner', label: t.partner ? `${t.partner.firstName} (delivery partner)` : 'Delivery partner' });
  if (drop) markers.push({ id: 'home', position: drop, kind: 'home', label: 'Your address' });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <Icon name="bike" size={16} />
        {t.partner ? (
          <span>
            {t.partner.firstName} · {humanize(t.partner.vehicleType)}
          </span>
        ) : (
          <span>Finding a delivery partner…</span>
        )}
        {t.simulated ? (
          <Badge tone="info" icon="info">
            SIMULATED
          </Badge>
        ) : null}
        <EtaText minutes={t.estimatedMinutes} source={t.estimateSource} />
      </div>
      {t.location ? (
        <>
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <MapView center={t.location} markers={markers} ariaLabel="Delivery partner location" className="h-56" />
          </Suspense>
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600" aria-live="polite">
            <RelativeTime value={t.lastLocationAt} prefix="updated" />
            {stale ? (
              <span className="inline-flex items-center gap-1 font-medium text-warn-800">
                <Icon name="alert" size={14} /> Location may be out of date
              </span>
            ) : null}
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-600">The partner&rsquo;s live location appears once they pick up your order.</p>
      )}
    </div>
  );
}
