/** Step 2: address, map pin and delivery radius. The pin can be dropped on the map or taken from the device. */
import { useMutation } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { Button, Field, Input, Skeleton } from '../../../components/ui';
import { useGeolocation, GEO_MESSAGES } from '../../../hooks/useGeolocation';
import { fieldErrors } from '../../../lib/errors';
import { DEFAULT_CENTER, roundGeo, type GeoPoint } from '../../../lib/geo';
import { reverseGeocode } from '../../../lib/places';
import { restaurantApi } from '../api';
import { StepFrame, type StepProps } from './StepFrame';

const MapView = lazy(() => import('../../../components/ui/Map').then((m) => ({ default: m.MapView })));

const PINCODE = /^[1-9][0-9]{5}$/;

export interface LocationValues {
  line1: string;
  line2: string;
  /** MKT-5 neighbourhood shown next to the name ("Indiranagar"). */
  locality: string;
  city: string;
  pincode: string;
  pin: GeoPoint | null;
  radius: string;
}

export function validateLocation(v: LocationValues): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.line1.trim()) e.line1 = 'Enter the street address.';
  if (v.locality.trim().length > 60) e.locality = 'Use 60 characters or fewer.';
  if (!v.city.trim()) e.city = 'Enter the city.';
  if (!PINCODE.test(v.pincode.trim())) e.pincode = 'Enter a valid 6-digit pincode.';
  if (!v.pin) e.pin = 'Drop a pin on the map so riders can find you.';
  const r = Number(v.radius);
  if (!v.radius.trim() || !Number.isFinite(r) || r < 0.5 || r > 15) e.radius = 'Delivery radius must be between 0.5 and 15 km.';
  return e;
}

export function LocationStep({ restaurant, onSaved, next, back }: StepProps) {
  const geo = useGeolocation();
  const [v, setV] = useState<LocationValues>(() => ({
    line1: restaurant?.address?.line1 ?? '',
    line2: restaurant?.address?.line2 ?? '',
    locality: restaurant?.address?.locality ?? '',
    city: restaurant?.address?.city ?? '',
    pincode: restaurant?.address?.pincode ?? '',
    pin: restaurant?.location ?? null,
    radius: String(restaurant?.deliveryRadiusKm ?? 6),
  }));
  const [show, setShow] = useState(false);
  const errors = validateLocation(v);
  const save = useMutation({
    mutationFn: () =>
      restaurantApi.patch(restaurant!.id, {
        address: {
          line1: v.line1.trim(),
          ...(v.line2.trim() ? { line2: v.line2.trim() } : {}),
          ...(v.locality.trim() ? { locality: v.locality.trim() } : {}),
          city: v.city.trim(),
          pincode: v.pincode.trim(),
        },
        location: v.pin!,
        deliveryRadiusKm: Number(v.radius),
      }),
    onSuccess: (r) => {
      onSaved(r);
      next();
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string, serverKey = k) => (show ? errors[k] : undefined) ?? server[serverKey];
  const set = <K extends keyof LocationValues>(k: K, val: LocationValues[K]) => setV((p) => ({ ...p, [k]: val }));

  // fill empty locality / city / pincode from the pin (MKT-1 reverse geocode); never overwrites typed values
  const prefill = async (p: GeoPoint) => {
    try {
      const rev = await reverseGeocode(p);
      setV((prev) => ({
        ...prev,
        locality: prev.locality || rev.locality || '',
        city: prev.city || rev.city || '',
        pincode: prev.pincode || rev.pincode || '',
      }));
    } catch {
      /* best effort: the owner can type them */
    }
  };
  const pick = (p: GeoPoint) => {
    const pin = roundGeo(p);
    set('pin', pin);
    void prefill(pin);
  };
  const useMyLocation = async () => {
    const fix = await geo.request();
    if (fix) pick({ lat: fix.lat, lng: fix.lng });
  };

  return (
    <StepFrame
      title="Location"
      description="Customers see your address; riders navigate to the pin, so place it on your kitchen entrance."
      submitting={save.isPending}
      error={save.isError && Object.keys(server).length === 0 ? save.error : null}
      onBack={back}
      onSubmit={() => {
        if (Object.keys(errors).length > 0) {
          setShow(true);
          return;
        }
        save.mutate();
      }}
    >
      <Field label="Address line 1" required error={err('line1', 'address.line1')}>
        <Input value={v.line1} onChange={(e) => set('line1', e.target.value)} autoComplete="address-line1" />
      </Field>
      <Field label="Address line 2" optional>
        <Input value={v.line2} onChange={(e) => set('line2', e.target.value)} autoComplete="address-line2" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Locality" optional hint="e.g. Indiranagar" error={err('locality', 'address.locality')}>
          <Input value={v.locality} onChange={(e) => set('locality', e.target.value)} maxLength={60} autoComplete="address-level3" />
        </Field>
        <Field label="City" required error={err('city', 'address.city')}>
          <Input value={v.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" />
        </Field>
        <Field label="Pincode" required error={err('pincode', 'address.pincode')}>
          <Input inputMode="numeric" maxLength={6} value={v.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, ''))} autoComplete="postal-code" />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-fg">
            Map pin<span aria-hidden="true" className="ml-0.5 text-bad">*</span>
          </p>
          <Button variant="outline" size="sm" icon="crosshair" onClick={() => void useMyLocation()} loading={geo.status === 'locating'}>
            Use my current location
          </Button>
        </div>
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <MapView
            center={v.pin ?? DEFAULT_CENTER}
            picked={v.pin}
            onPick={pick}
            ariaLabel="Choose your restaurant location"
            zoom={v.pin ? 16 : 12}
          />
        </Suspense>
        {geo.status === 'denied' || geo.status === 'unavailable' || geo.status === 'timeout' || geo.status === 'unsupported' ? (
          <p role="status" className="text-sm text-fg-3">{GEO_MESSAGES[geo.status]}</p>
        ) : null}
        <p aria-live="polite" className="text-sm text-fg-3">
          {v.pin ? `Pin set at ${v.pin.lat}, ${v.pin.lng}. Tap the map to move it.` : 'Tap the map to drop your pin.'}
        </p>
        {err('pin', 'location') ? (
          <p role="alert" className="text-sm font-medium text-bad">{err('pin', 'location')}</p>
        ) : null}
      </div>

      <Field label="Delivery radius" required hint="0.5 to 15 km from your pin" error={err('radius', 'deliveryRadiusKm')}>
        <Input type="number" inputMode="decimal" step="0.5" min="0.5" max="15" suffix="km" value={v.radius} onChange={(e) => set('radius', e.target.value)} />
      </Field>
    </StepFrame>
  );
}
