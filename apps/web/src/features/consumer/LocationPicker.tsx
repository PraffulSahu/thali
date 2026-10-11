/**
 * Delivery location picker (design-spec §7.2 "Location picker"; PRD C-1). Four ways to choose:
 *   - type an address (MKT-1 autocomplete `GET /discovery/places` → `/places/:id`)
 *   - "Use my current location" (browser geolocation → `GET /discovery/reverse` for a readable label)
 *   - drop a pin on the map
 *   - a saved address (signed in)
 * Every candidate is checked with `GET /discovery/serviceability` (deliverable ≠ nearby). The choice is stored
 * in the shared `thali.location` store (lib/location), so discovery, restaurant pages and checkout follow it.
 *
 *   <LocationPicker onDone={close} />          inline
 *   <LocationDialog open onClose={…} />        header chip / "Change location"
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { AddressCard, Button, Dialog, Icon, InfoNotice, InlineError, Lbl, Skeleton } from '../../components/ui';
import { AddressAutocomplete } from '../../components/location/AddressAutocomplete';
import { useGeolocation } from '../../hooks/useGeolocation';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DEFAULT_CENTER, roundGeo } from '../../lib/geo';
import { getPlace, reverseGeocode, shortLabel, type PlaceSuggestion } from '../../lib/places';
import { cn } from '../../lib/cn';
import { formatAddress, useAddresses, type SavedAddress } from './api';
import { setLocation, useChosenLocation, type ChosenLocation } from './location';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));

interface Serviceability {
  serviceable: boolean;
  area: { id: string; name: string; minOrderPaise: number } | null;
}

export function useServiceability(point: GeoPoint | null) {
  return useQuery({
    queryKey: ['serviceability', point?.lat, point?.lng],
    queryFn: () => api<Serviceability>('/discovery/serviceability', { auth: false, query: { lat: point!.lat, lng: point!.lng } }),
    enabled: point !== null,
    staleTime: 60_000,
  });
}

type Candidate = Omit<ChosenLocation, 'label'> & { label?: string };

export interface LocationPickerProps {
  onDone: (loc: ChosenLocation) => void;
  className?: string;
}

/** Saved-address → chosen location (label = "Home"; second line = street + locality). */
export function locationFromAddress(a: SavedAddress): ChosenLocation {
  return {
    lat: a.location.lat,
    lng: a.location.lng,
    source: 'address',
    addressId: a.id,
    label: a.label || shortLabel(a.line1),
    address: [a.line1, a.locality ?? a.line2].filter(Boolean).join(', '),
  };
}

export function LocationPicker({ onDone, className }: LocationPickerProps) {
  const { isAuthenticated } = useAuth();
  const current = useChosenLocation();
  const geo = useGeolocation();
  const addresses = useAddresses(isAuthenticated);
  const [candidate, setCandidate] = useState<Candidate | null>(current ? { ...current } : null);
  const [resolving, setResolving] = useState(false);
  const [placeError, setPlaceError] = useState<unknown>(null);
  const point = candidate ? roundGeo({ lat: candidate.lat, lng: candidate.lng }) : null;
  const service = useServiceability(point);

  /** Readable label for a GPS fix / pin (MKT-1 reverse). Best effort: older stacks answer 404. */
  const labelFor = async (p: GeoPoint, fallback: string) => {
    try {
      const r = await reverseGeocode(p);
      return { label: shortLabel(r.label), address: r.label };
    } catch {
      return { label: fallback };
    }
  };

  const useGps = async () => {
    const fix = await geo.request();
    if (!fix) return;
    setCandidate({ lat: fix.lat, lng: fix.lng, source: 'gps', label: 'Current location' });
    const l = await labelFor(fix, 'Current location');
    setCandidate((c) => (c && c.source === 'gps' && c.lat === fix.lat && c.lng === fix.lng ? { ...c, ...l } : c));
  };
  const pin = async (p: GeoPoint) => {
    setCandidate({ ...p, source: 'pin', label: 'Pinned location' });
    const l = await labelFor(p, 'Pinned location');
    setCandidate((c) => (c && c.source === 'pin' && c.lat === p.lat && c.lng === p.lng ? { ...c, ...l } : c));
  };
  const pickPlace = async (s: PlaceSuggestion) => {
    setPlaceError(null);
    setResolving(true);
    try {
      const d = await getPlace(s.id);
      setCandidate({ lat: d.location.lat, lng: d.location.lng, source: 'address', placeId: d.id, label: s.primary, address: d.formattedAddress });
    } catch (e) {
      if (s.location) setCandidate({ ...s.location, source: 'address', placeId: s.id, label: s.primary, address: [s.primary, s.secondary].filter(Boolean).join(', ') });
      else setPlaceError(e);
    } finally {
      setResolving(false);
    }
  };

  const confirm = () => {
    if (!candidate) return;
    const loc: ChosenLocation = {
      lat: candidate.lat,
      lng: candidate.lng,
      source: candidate.source,
      label: candidate.label ?? (candidate.source === 'pin' ? 'Pinned location' : 'Current location'),
      ...(candidate.addressId ? { addressId: candidate.addressId } : {}),
      ...(candidate.address ? { address: candidate.address } : {}),
      ...(candidate.placeId ? { placeId: candidate.placeId } : {}),
    };
    setLocation(loc);
    onDone(loc);
  };

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <AddressAutocomplete label="Search for your delivery address" placeholder="Search street, area or landmark" onSelect={(s) => void pickPlace(s)} bias={point} />
      <InlineError error={placeError} />

      <div className="flex flex-col gap-2">
        <Button variant="outline" icon="crosshair" onClick={() => void useGps()} loading={geo.status === 'locating'} fullWidth>
          Use my current location
        </Button>
        {geo.message ? (
          <InfoNotice tone="warn" role="alert" icon="alert">
            {geo.message}
          </InfoNotice>
        ) : null}
      </div>

      {isAuthenticated && addresses.data && addresses.data.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2">
            <Lbl>Saved addresses</Lbl>
          </legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
            {addresses.data.map((a) => (
              <AddressCard
                key={a.id}
                name="saved-location"
                label={a.label || 'Address'}
                address={formatAddress(a)}
                isDefault={a.isDefault}
                checked={candidate?.addressId === a.id}
                onSelect={() => setCandidate(locationFromAddress(a))}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-fg">Or drop a pin on the map</p>
        <p className="text-[13px] text-fg-3">Tap the map where you want your order delivered, or move the map and use “Pin map centre”.</p>
        <div className="overflow-hidden rounded-field border border-line">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <MapView center={point ?? DEFAULT_CENTER} picked={point} onPick={(p) => void pin(p)} ariaLabel="Choose delivery location on the map" className="h-64" />
          </Suspense>
        </div>
      </div>

      <div aria-live="polite" className="min-h-6 text-sm">
        {resolving ? <span className="text-fg-3">Finding that address…</span> : null}
        {point && service.isPending && !resolving ? <span className="text-fg-3">Checking if we deliver here…</span> : null}
        {point && service.data?.serviceable ? (
          <span className="flex items-center gap-2 text-ok">
            <Icon name="check" size={16} /> We deliver to {candidate?.label ?? 'this point'}
            {service.data.area ? ` (${service.data.area.name})` : ''}.
          </span>
        ) : null}
        {point && service.data && !service.data.serviceable ? (
          <InfoNotice tone="warn" icon="alert">
            We don&rsquo;t deliver here yet. You can still browse, but no restaurants will be listed.
          </InfoNotice>
        ) : null}
        {service.isError ? <InlineError error={new Error("Couldn't check delivery coverage. You can still continue.")} /> : null}
      </div>

      <Button onClick={confirm} disabled={!candidate} fullWidth size="lg" icon="location">
        Deliver here
      </Button>
      {!candidate ? <p className="text-center text-[13px] text-fg-3">Choose a location above to continue.</p> : null}
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
