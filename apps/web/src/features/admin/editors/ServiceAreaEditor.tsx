/**
 * Service area editor: click the map to add polygon vertices (or use "Pin map centre" / the vertex list for
 * keyboard-only use), plus the delivery fee rule and minimum order. The server validates the geometry.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { Button } from '../../../components/ui/Button';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';
import { Skeleton } from '../../../components/ui/Skeleton';
import { DEFAULT_CENTER } from '../../../lib/geo';
import { paiseToRupees, rupeesToPaise, type ServiceArea } from '../api';
import { EditorDialog, useCatalogSave } from './EditorShell';
import type { CenterGetter } from './PolygonMap';

const PolygonMap = lazy(() => import('./PolygonMap'));

/** GeoJSON ring ([lng, lat], closed) to vertices without the closing duplicate. */
export function ringToPoints(area: ServiceArea | null): GeoPoint[] {
  const ring = area?.polygon.coordinates[0] ?? [];
  const pts = ring.map(([lng, lat]) => ({ lat: lat!, lng: lng! }));
  if (pts.length > 1 && pts[0]!.lat === pts[pts.length - 1]!.lat && pts[0]!.lng === pts[pts.length - 1]!.lng) pts.pop();
  return pts;
}
/** GeoJSON Polygon with the ring explicitly closed (first point repeated at the end). */
export const pointsToPolygon = (points: GeoPoint[]) => {
  const ring = points.map((p) => [round(p.lng), round(p.lat)]);
  if (ring.length) ring.push([...ring[0]!]);
  return { type: 'Polygon' as const, coordinates: [ring] };
};
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const decimal = (s: string) => (/^\d{1,3}(\.\d{1,3})?$/.test(s.trim()) ? Number(s.trim()) : null);

export default function ServiceAreaEditor({ open, item, onClose }: { open: boolean; item: ServiceArea | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [active, setActive] = useState(true);
  const [minOrder, setMinOrder] = useState('0');
  const [base, setBase] = useState('');
  const [baseKm, setBaseKm] = useState('');
  const [perKm, setPerKm] = useState('');
  const [max, setMax] = useState('');
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [cornerError, setCornerError] = useState<string | null>(null);
  const centerRef = useRef<CenterGetter | null>(null);
  const save = useCatalogSave<ServiceArea>('service-areas', 'Service area', item);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setPoints(ringToPoints(item));
    setActive(item?.active ?? true);
    setMinOrder(paiseToRupees(item?.minOrderPaise ?? 0) || '0');
    setBase(paiseToRupees(item?.deliveryFee.basePaise));
    setBaseKm(item ? String(item.deliveryFee.baseKm) : '');
    setPerKm(paiseToRupees(item?.deliveryFee.perKmPaise));
    setMax(paiseToRupees(item?.deliveryFee.maxPaise));
    setLatText('');
    setLngText('');
    setCornerError(null);
  }, [open, item]);

  const addCorner = (p: GeoPoint) => setPoints((cur) => [...cur, { lat: round(p.lat), lng: round(p.lng) }]);
  const addTyped = () => {
    const lat = Number(latText.trim());
    const lng = Number(lngText.trim());
    if (latText.trim() === '' || lngText.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      setCornerError('Enter a latitude between -90 and 90 and a longitude between -180 and 180.');
      return;
    }
    setCornerError(null);
    addCorner({ lat, lng });
    setLatText('');
    setLngText('');
  };
  const onCornerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTyped();
    }
  };

  const basePaise = rupeesToPaise(base);
  const baseKmNum = decimal(baseKm);
  const perKmPaise = rupeesToPaise(perKm);
  const maxPaise = rupeesToPaise(max);
  const minPaise = rupeesToPaise(minOrder);
  const feeOrderError = basePaise !== null && maxPaise !== null && maxPaise < basePaise ? 'The maximum fee must be at least the base fee.' : undefined;
  const valid = name.trim().length > 0 && points.length >= 3 && basePaise !== null && baseKmNum !== null && baseKmNum <= 50 && perKmPaise !== null && maxPaise !== null && minPaise !== null && !feeOrderError;

  const center = useMemo(() => (points.length ? points[0]! : DEFAULT_CENTER), [points.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <EditorDialog
      open={open}
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.name}` : 'Add a service area'}
      description="Customers inside the area can order. Fees and the minimum order apply inside it."
      submitLabel={item ? 'Save changes' : 'Add service area'}
      valid={valid}
      onSubmit={() =>
        save.mutateAsync({
          name: name.trim(),
          polygon: pointsToPolygon(points),
          active,
          minOrderPaise: minPaise,
          deliveryFee: { basePaise, baseKm: baseKmNum, perKmPaise, maxPaise },
        })
      }
    >
      {(errors) => (
        <>
          <Field label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-slate-800">Boundary <span className="text-danger-700" aria-hidden="true">*</span></p>
            <p className="text-sm text-slate-600">Click the map to add corners in order around the area. Without a mouse, pan the map with the arrow keys and use “Add corner at map centre”, or type coordinates below.</p>
            <Suspense fallback={<Skeleton className="h-72 w-full" />}>
              <PolygonMap points={points} center={center} onAdd={addCorner} centerRef={centerRef} />
            </Suspense>
            <div className="flex flex-wrap items-end gap-2">
              <Button type="button" size="sm" variant="secondary" icon="crosshair" onClick={() => { const c = centerRef.current?.(); if (c) addCorner(c); }}>
                Add corner at map centre
              </Button>
            </div>
            <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="Corner latitude" error={cornerError ?? undefined}>
                <Input inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} onKeyDown={onCornerKey} placeholder="12.9716" />
              </Field>
              <Field label="Corner longitude">
                <Input inputMode="decimal" value={lngText} onChange={(e) => setLngText(e.target.value)} onKeyDown={onCornerKey} placeholder="77.5946" />
              </Field>
              <Button type="button" variant="secondary" onClick={addTyped}>
                Add corner
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span role="status" className="text-sm text-slate-700">
                {points.length} {points.length === 1 ? 'corner' : 'corners'}{points.length < 3 ? ` (need at least 3)` : ''}
              </span>
              <Button type="button" size="sm" variant="secondary" disabled={points.length === 0} onClick={() => setPoints((cur) => cur.slice(0, -1))}>
                Undo last corner
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={points.length === 0} onClick={() => setPoints([])}>
                Clear
              </Button>
            </div>
            {errors.polygon ? <p role="alert" className="text-sm font-medium text-danger-700">{errors.polygon}</p> : null}
            {points.length ? (
              <ol aria-label="Corners" className="grid max-h-32 grid-cols-1 gap-1 overflow-y-auto text-sm text-slate-700 sm:grid-cols-2">
                {points.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 rounded-control bg-surface-muted px-2 py-1">
                    <span className="tabular-nums">{i + 1}. {p.lat.toFixed(5)}, {p.lng.toFixed(5)}</span>
                    <button type="button" className="min-h-8 rounded px-2 text-danger-700 hover:bg-danger-50" onClick={() => setPoints((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove corner ${i + 1}`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>

          <fieldset className="grid grid-cols-1 gap-4 rounded-control border border-slate-200 p-3 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold text-slate-800">Delivery fee rule</legend>
            <Field label="Base fee" required hint="Charged up to the base distance" error={base !== '' && basePaise === null ? 'Enter rupees.' : errors['deliveryFee.basePaise']}>
              <Input inputMode="decimal" prefix="₹" value={base} onChange={(e) => setBase(e.target.value)} />
            </Field>
            <Field label="Base distance" required error={baseKm !== '' && (baseKmNum === null || baseKmNum > 50) ? 'A distance up to 50 km.' : errors['deliveryFee.baseKm']}>
              <Input inputMode="decimal" suffix="km" value={baseKm} onChange={(e) => setBaseKm(e.target.value)} />
            </Field>
            <Field label="Per extra km" required error={perKm !== '' && perKmPaise === null ? 'Enter rupees.' : errors['deliveryFee.perKmPaise']}>
              <Input inputMode="decimal" prefix="₹" value={perKm} onChange={(e) => setPerKm(e.target.value)} />
            </Field>
            <Field label="Maximum fee" required error={feeOrderError ?? (max !== '' && maxPaise === null ? 'Enter rupees.' : errors['deliveryFee.maxPaise'])}>
              <Input inputMode="decimal" prefix="₹" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
          </fieldset>
          <Field label="Minimum order" required error={minPaise === null ? 'Enter rupees, 0 for none.' : errors.minOrderPaise}>
            <Input inputMode="decimal" prefix="₹" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
          </Field>
          <Checkbox label="Active" description="Inactive areas stop accepting new orders" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </>
      )}
    </EditorDialog>
  );
}
