/**
 * Discovery filters (PRD C-3): veg-only, open now, cuisine, price band, sort. State lives in the URL
 * (`?veg=1&open=1&cuisine=a,b&price=1,2&sort=eta`) so lists are shareable and survive reloads.
 * Rating sort only orders restaurants with ≥ 5 real ratings first; others show "New" (server rule).
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { Cuisine, DiscoveryFilterState, DiscoverySort } from './api';

const SORTS: { value: DiscoverySort; label: string }[] = [
  { value: 'distance', label: 'Distance' },
  { value: 'eta', label: 'Delivery time' },
  { value: 'deliveryFee', label: 'Delivery fee' },
  { value: 'rating', label: 'Rating' },
];

const csv = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

export function useDiscoveryFilters(): [DiscoveryFilterState, (patch: Partial<DiscoveryFilterState>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.find((s) => s.value === params.get('sort'))?.value ?? 'distance') as DiscoverySort;
  const state: DiscoveryFilterState = {
    q: params.get('q') ?? undefined,
    veg: params.get('veg') === '1',
    openNow: params.get('open') === '1',
    cuisine: csv(params.get('cuisine')),
    priceBand: csv(params.get('price')).map(Number).filter((n) => n >= 1 && n <= 3),
    sort,
  };
  const update = (patch: Partial<DiscoveryFilterState>) => {
    const next = { ...state, ...patch };
    const p = new URLSearchParams();
    if (next.q) p.set('q', next.q);
    if (next.veg) p.set('veg', '1');
    if (next.openNow) p.set('open', '1');
    if (next.cuisine?.length) p.set('cuisine', next.cuisine.join(','));
    if (next.priceBand?.length) p.set('price', next.priceBand.join(','));
    if (next.sort !== 'distance') p.set('sort', next.sort);
    setParams(p, { replace: true });
  };
  const clear = () => setParams(new URLSearchParams(), { replace: true });
  return [state, update, clear];
}

export const hasActiveFilters = (f: DiscoveryFilterState) => Boolean(f.q || f.veg || f.openNow || f.cuisine?.length || f.priceBand?.length);

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'min-h-touch shrink-0 rounded-pill border px-3 text-sm font-medium transition-colors',
        pressed ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-surface text-slate-700 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}

const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

export function DiscoveryFilters({ value, onChange, onClear }: { value: DiscoveryFilterState; onChange: (p: Partial<DiscoveryFilterState>) => void; onClear: () => void }) {
  const cuisines = useQuery({
    queryKey: ['cuisines'],
    queryFn: () => api<{ items: Cuisine[] }>('/cuisines', { auth: false }).then((r) => r.items),
    staleTime: 10 * 60_000,
  });
  return (
    <div className="space-y-3" role="group" aria-label="Filters">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <Chip pressed={!!value.veg} onClick={() => onChange({ veg: !value.veg })}>
          Pure veg
        </Chip>
        <Chip pressed={!!value.openNow} onClick={() => onChange({ openNow: !value.openNow })}>
          Open now
        </Chip>
        {[1, 2, 3].map((b) => (
          <Chip key={b} pressed={!!value.priceBand?.includes(b)} onClick={() => onChange({ priceBand: toggle(value.priceBand, b) })}>
            <span aria-hidden>{'₹'.repeat(b)}</span>
            <span className="sr-only">{b === 1 ? 'Budget (under ₹200 per item)' : b === 2 ? 'Mid (₹200 to ₹400 per item)' : 'Premium (over ₹400 per item)'}</span>
          </Chip>
        ))}
        {(cuisines.data ?? []).map((c) => (
          <Chip key={c.id} pressed={!!value.cuisine?.includes(c.slug)} onClick={() => onChange({ cuisine: toggle(value.cuisine, c.slug) })}>
            {c.name}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          Sort by
          <Select
            className="w-44"
            value={value.sort}
            onChange={(e) => onChange({ sort: e.target.value as DiscoverySort })}
            options={SORTS}
          />
        </label>
        {hasActiveFilters(value) ? (
          <Button variant="link" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {value.sort === 'rating' ? <p className="text-xs text-slate-600">Rated restaurants (5+ real ratings) first; others are marked “New”.</p> : null}
    </div>
  );
}
