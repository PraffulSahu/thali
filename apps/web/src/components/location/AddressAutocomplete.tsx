/**
 * Address autocomplete combobox (WAI-ARIA 1.2 combobox + listbox) over MKT-1 `GET /discovery/places`.
 * Debounced 250 ms, min 2 chars; ↑/↓ move, Enter selects, Esc closes, Home/End jump. Reusable by the consumer
 * location picker.
 *
 *   <AddressAutocomplete id="hero-address" label="Enter your delivery address" onSelect={(s) => choose(s)}
 *     bias={loc} variant="hero" />
 *
 * `onSelect` gets the suggestion; resolve it with `getPlace(s.id)` (location + serviceable).
 */
import { useQuery } from '@tanstack/react-query';
import { forwardRef, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { PLACES_MIN_QUERY, searchPlaces, type PlaceSuggestion } from '../../lib/places';
import { Icon } from '../ui/Icon';

export const PLACES_DEBOUNCE_MS = 250;

export interface AddressAutocompleteProps {
  id?: string;
  /** Accessible name (visually rendered as placeholder in the hero). */
  label: string;
  placeholder?: string;
  onSelect: (s: PlaceSuggestion) => void;
  /** Called when Enter is pressed with no highlighted option (e.g. "Find food"). */
  onSubmitEmpty?: (query: string, first: PlaceSuggestion | undefined) => void;
  bias?: GeoPoint | null;
  variant?: 'hero' | 'field';
  disabled?: boolean;
  /** Trailing controls inside the pill (hero: Use my location + Find food). */
  trailing?: ReactNode;
  describedBy?: string;
  onQueryChange?: (q: string) => void;
  /** Latest suggestions for the current query (e.g. so an external "Find food" button can pick the first). */
  onItemsChange?: (items: PlaceSuggestion[]) => void;
}

export const AddressAutocomplete = forwardRef<HTMLInputElement, AddressAutocompleteProps>(function AddressAutocomplete(
  { id, label, placeholder, onSelect, onSubmitEmpty, bias, variant = 'field', disabled, trailing, describedBy, onQueryChange, onItemsChange },
  ref,
) {
  const auto = useId().replace(/:/g, '');
  const inputId = id ?? `addr${auto}`;
  const listId = `${inputId}-list`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const debounced = useDebouncedValue(query.trim(), PLACES_DEBOUNCE_MS);
  const enabled = debounced.length >= PLACES_MIN_QUERY;
  const places = useQuery({
    queryKey: ['places', debounced, bias?.lat ?? null, bias?.lng ?? null],
    queryFn: ({ signal }) => searchPlaces(debounced, bias, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const items = enabled && debounced === query.trim() ? (places.data?.items ?? []) : [];
  const showList = open && query.trim().length >= PLACES_MIN_QUERY;
  const pending = showList && (debounced !== query.trim() || places.isFetching) && items.length === 0;
  const demo = items.some((i) => i.source === 'DEMO_GAZETTEER');
  const firstId = items[0]?.id;
  useEffect(() => {
    onItemsChange?.(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify when the result set changes
  }, [firstId, items.length]);

  const choose = (s: PlaceSuggestion) => {
    setQuery(s.secondary ? `${s.primary}, ${s.secondary}` : s.primary);
    setOpen(false);
    setActive(-1);
    onSelect(s);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (items.length) setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === 'Home' && showList && items.length) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && showList && items.length) {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showList && active >= 0 && items[active]) choose(items[active]!);
      else onSubmitEmpty?.(query.trim(), items[0]);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  };

  const hero = variant === 'hero';
  return (
    <div className="relative min-w-0 flex-1">
      <div className={cn('flex items-center gap-2.5', hero ? 'h-12 pl-3' : 'h-[46px] rounded-control border border-line bg-bg px-3.5 focus-within:border-fg-3 focus-within:shadow-[0_0_0_4px_var(--muted)]')}>
        <Icon name="location" size={hero ? 20 : 18} className={cn('shrink-0', hero ? 'text-pri' : 'text-fg-3')} />
        <input
          ref={ref}
          id={inputId}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 && items[active] ? `${listId}-${active}` : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder ?? label}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
            onQueryChange?.(e.target.value);
          }}
          onFocus={() => query.trim().length >= PLACES_MIN_QUERY && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className={cn('min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none', hero ? 'text-base font-medium' : 'text-[15px]')}
        />
      </div>
      {trailing}
      {showList ? (
        <div className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-field border border-line bg-card shadow-float">
          <ul id={listId} role="listbox" aria-label="Address suggestions" className="max-h-80 overflow-y-auto py-1.5">
            {items.map((s, i) => (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s)}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-start gap-3 px-4 py-2.5', i === active ? 'bg-fill' : '')}
              >
                <Icon name="location" size={16} className="mt-0.5 shrink-0 text-fg-3" />
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-semibold text-fg">{s.primary}</span>
                  {s.secondary ? <span className="block truncate text-[13px] text-fg-3">{s.secondary}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {pending ? (
            <p role="status" className="px-4 py-3 text-[13px] text-fg-3">
              Searching…
            </p>
          ) : places.isError && items.length === 0 ? (
            <p role="alert" className="px-4 py-3 text-[13px] text-bad">
              {errorMessage(places.error)}
            </p>
          ) : items.length === 0 && !places.isFetching ? (
            <p role="status" className="px-4 py-3 text-[13px] text-fg-3">
              No matching places. Try a locality or road name in Bengaluru.
            </p>
          ) : null}
          {demo ? <p className="border-t border-line bg-bg-2 px-4 py-2 font-mono text-[11px] text-fg-3">DEMO ADDRESS DATA · seeded Bengaluru localities</p> : null}
        </div>
      ) : null}
    </div>
  );
});
