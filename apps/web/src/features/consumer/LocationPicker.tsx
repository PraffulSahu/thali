/**
 * Choose the delivery location (PRD C-1): browser geolocation, a map pin, or a saved address (signed in).
 * The choice is checked against `/discovery/serviceability` (deliverable ≠ nearby) and persisted to localStorage.
 *
 *   <LocationPicker onDone={close} />            inline (home page when nothing is chosen yet)
 *   <LocationDialog open onClose={...} />        from the header chip (HeaderActions.tsx)
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { Badge, Button, Dialog, Icon, InlineError, Skeleton } from '../../components/ui';
import { useGeolocation } from '../../hooks/useGeolocation';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DEFAULT_CENTER, roundGeo } from '../../lib/geo';
import { cn } from '../../lib/cn';
import { formatAddress, useAddresses, type SavedAddress } from './api';
import { setLocation, useChosenLocation, type ChosenLocation } from './location';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));

interface Serviceability {
  serviceable: boolean;
  area: { id: string; name: string; minOrderPaise: number } | null;
}

function useServiceability(point: GeoPoint | null) {
  return useQuery({
    queryKey: ['serviceability', point?.lat, point?.lng],
    queryFn: () => api<Serviceability>('/discovery/serviceability', { auth: false, query: { lat: point!.lat, lng: point!.lng } }),
    enabled: point !== null,
    staleTime: 60_000,
  });
}

export interface LocationPickerProps {
  onDone: (loc: ChosenLocation) => void;
  className?: string;
}

export function LocationPicker({ onDone, className }: LocationPickerProps) {
  const { isAuthenticated } = useAuth();
  const current = useChosenLocation();
  const geo = useGeolocation();
  const addresses = useAddresses(isAuthenticated);
  const [candidate, setCandidate] = useState<Omit<ChosenLocation, 'label'> & { label?: string } | null>(
    current ? { ...current } : null,
  );
  const point = candidate ? roundGeo({ lat: candidate.lat, lng: candidate.lng }) : null;
  const service = useServiceability(point);

  const useGps = async () => {
    const fix = await geo.request();
    if (fix) setCandidate({ lat: fix.lat, lng: fix.lng, source: 'gps', label: 'Current location' });
  };
  const pickAddress = (a: SavedAddress) =>
    setCandidate({ ...a.location, source: 'address', addressId: a.id, label: a.label || a.line1 });

  const confirm = () => {
    if (!candidate) return;
    const loc: ChosenLocation = {
      lat: candidate.lat,
      lng: candidate.lng,
      source: candidate.source,
      label: candidate.label ?? (candidate.source === 'pin' ? 'Pinned location' : 'Current location'),
      ...(candidate.addressId ? { addressId: candidate.addressId } : {}),
    };
    setLocation(loc);
    onDone(loc);
  };

  return (
    <div className={cn('space-y-5', className)}>
      <div className="space-y-2">
        <Button variant="secondary" icon="crosshair" onClick={() => void useGps()} loading={geo.status === 'locating'} fullWidth>
          Use my current location
        </Button>
        {geo.message ? (
          <p role="alert" className="flex gap-2 rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">
            <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
            <span>{geo.message}</span>
          </p>
        ) : null}
      </div>

      {isAuthenticated && addresses.data && addresses.data.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-slate-700">Saved addresses</legend>
          {addresses.data.map((a) => {
            const selected = candidate?.addressId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={selected}
                onClick={() => pickAddress(a)}
                className={cn(
                  'flex min-h-touch w-full items-start gap-3 rounded-control border px-3 py-2 text-left',
                  selected ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50',
                )}
              >
                <Icon name={a.label?.toLowerCase() === 'home' ? 'home' : 'location'} size={18} className="mt-0.5 text-slate-500" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900">
                    {a.label || 'Address'} {a.isDefault ? <Badge tone="neutral" className="ml-1">Default</Badge> : null}
                  </span>
                  <span className="block truncate text-sm text-slate-600">{formatAddress(a)}</span>
                </span>
              </button>
            );
          })}
        </fieldset>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-semibold text-slate-700">Or drop a pin on the map</p>
        <p className="text-sm text-slate-600">Tap the map where you want your order delivered, or move the map and use “Pin map centre”.</p>
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <MapView
            center={point ?? DEFAULT_CENTER}
            picked={point}
            onPick={(p) => setCandidate({ ...p, source: 'pin', label: 'Pinned location' })}
            ariaLabel="Choose delivery location on the map"
            className="h-64"
          />
        </Suspense>
      </div>

      <div aria-live="polite" className="min-h-6 text-sm">
        {point && service.isPending ? <span className="text-slate-600">Checking if we deliver here…</span> : null}
        {point && service.data?.serviceable ? (
          <span className="flex items-center gap-2 text-success-800">
            <Icon name="check" size={16} /> We deliver here{service.data.area ? ` (${service.data.area.name})` : ''}.
          </span>
        ) : null}
        {point && service.data && !service.data.serviceable ? (
          <span className="flex items-center gap-2 text-warn-800">
            <Icon name="alert" size={16} /> We don&rsquo;t deliver here yet. You can still browse, but no restaurants will be listed.
          </span>
        ) : null}
        {service.isError ? <InlineError error={new Error("Couldn't check delivery coverage. You can still continue.")} /> : null}
      </div>

      <Button onClick={confirm} disabled={!candidate} fullWidth size="lg" icon="location">
        Deliver here
      </Button>
      {!candidate ? <p className="text-center text-sm text-slate-600">Choose a location above to continue.</p> : null}
    </div>
  );
}

export function LocationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Delivery location" description="Restaurants are listed only if they deliver to this point." size="lg">
      <LocationPicker onDone={onClose} />
    </Dialog>
  );
}
