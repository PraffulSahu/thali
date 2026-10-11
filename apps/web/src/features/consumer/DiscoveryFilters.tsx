/**
 * Discover filters (board 10, 10-22…10-27; design-spec §6.4). State lives in the URL so lists are shareable:
 * `?cuisine=biryani&veg=1&open=1&price=1,2&sort=eta`. Desktop: the "Preferences / Price / Sort by" aside;
 * ≤1023: one horizontal scrollable pill row (Veg only · Open now · ₹ ₹₹ ₹₹₹ · Sort).
 * Rating sort: rated restaurants (5+ real ratings) first; others are marked "New" (server rule).
 */
import { useSearchParams } from 'react-router';
import { Field, FilterPill, Lbl, PriceChips, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import type { DiscoveryFilterState, DiscoverySort } from './api';

export const SORTS: { value: DiscoverySort; label: string }[] = [
  { value: 'distance', label: 'Distance' },
  { value: 'deliveryFee', label: 'Delivery fee' },
  { value: 'eta', label: 'Delivery time' },
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
    if (next.cuisine?.length) p.set('cuisine', next.cuisine.join(','));
    if (next.veg) p.set('veg', '1');
    if (next.openNow) p.set('open', '1');
    if (next.priceBand?.length) p.set('price', next.priceBand.join(','));
    if (next.sort !== 'distance') p.set('sort', next.sort);
    setParams(p, { replace: true });
  };
  /** 10-32 "Clear filters": cuisine, veg, open and price back to defaults (sort and search kept). */
  const clear = () => update({ cuisine: [], veg: false, openNow: false, priceBand: [] });
  return [state, update, clear];
}

export const hasActiveFilters = (f: DiscoveryFilterState) => Boolean(f.veg || f.openNow || f.cuisine?.length || f.priceBand?.length);

const RATING_NOTE = 'Rated restaurants (5+ real ratings) first; others are marked “New”.';

export function FiltersAside({ value, onChange, className }: { value: DiscoveryFilterState; onChange: (p: Partial<DiscoveryFilterState>) => void; className?: string }) {
  return (
    <aside aria-label="Filters" className={cn('flex flex-col gap-6', className)}>
      <div role="group" aria-labelledby="pref-lbl" className="flex flex-col gap-2">
        <Lbl>
          <span id="pref-lbl">Preferences</span>
        </Lbl>
        <FilterPill veg pressed={!!value.veg} onClick={() => onChange({ veg: !value.veg })} className="h-10 justify-start">
          Veg only
        </FilterPill>
        <FilterPill pressed={!!value.openNow} onClick={() => onChange({ openNow: !value.openNow })} className="h-10 justify-start">
          Open now
        </FilterPill>
      </div>
      <div className="flex flex-col gap-2">
        <Lbl>Price</Lbl>
        <PriceChips value={value.priceBand ?? []} onChange={(priceBand) => onChange({ priceBand })} />
      </div>
      <div className="flex flex-col gap-2">
        <Field label={<span className="lbl">Sort by</span>}>
          <Select value={value.sort} onChange={(e) => onChange({ sort: e.target.value as DiscoverySort })} options={SORTS} className="rounded-control" />
        </Field>
        {value.sort === 'rating' ? <p className="text-xs text-fg-3">{RATING_NOTE}</p> : null}
      </div>
    </aside>
  );
}

/** ≤1023 horizontal filter row under the cuisine band. */
export function FiltersRow({ value, onChange, className }: { value: DiscoveryFilterState; onChange: (p: Partial<DiscoveryFilterState>) => void; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div role="group" aria-label="Filters" className="no-scrollbar -mx-6 flex items-center gap-2 overflow-x-auto px-6 pb-1 max-sm:-mx-4 max-sm:px-4">
        <FilterPill veg pressed={!!value.veg} onClick={() => onChange({ veg: !value.veg })}>
          Veg only
        </FilterPill>
        <FilterPill pressed={!!value.openNow} onClick={() => onChange({ openNow: !value.openNow })}>
          Open now
        </FilterPill>
        <PriceChips value={value.priceBand ?? []} onChange={(priceBand) => onChange({ priceBand })} />
        <label className="relative inline-flex h-9 shrink-0 items-center rounded-pill border border-line bg-card pl-3.5 pr-8 text-[13.5px] font-medium text-fg-2">
          <span className="sr-only">Sort by</span>
          <span aria-hidden="true" className="mr-1 text-fg-3">
            Sort:
          </span>
          <select
            value={value.sort}
            onChange={(e) => onChange({ sort: e.target.value as DiscoverySort })}
            className="appearance-none bg-transparent pr-1 text-fg outline-none"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="pointer-events-none absolute right-3 text-fg-3">
            ▾
          </span>
        </label>
      </div>
      {value.sort === 'rating' ? <p className="text-xs text-fg-3">{RATING_NOTE}</p> : null}
    </div>
  );
}
