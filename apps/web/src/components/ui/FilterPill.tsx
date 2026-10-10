/**
 * Filter pills, price chips and choice pills (design-spec §3.5).
 *
 *   <FilterPill pressed={veg} onClick={() => setVeg(!veg)} veg>Veg only</FilterPill>
 *   <FilterPill pressed={openNow} onClick={toggleOpen}>Open now</FilterPill>
 *   <PriceChips value={bands} onChange={setBands} />                    // ₹ · ₹₹ · ₹₹₹ multi-select (1..3)
 *   <ChoicePills label="Prep time" value={prep} onChange={setPrep} columns={4}
 *     options={[{ value: '10', label: '10 min' }, …]} />               // 44px, 12px radius (owner prep/reject)
 */
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { FoodMarker } from './Icon';

export interface FilterPillProps extends Omit<ComponentProps<'button'>, 'children'> {
  pressed: boolean;
  children: ReactNode;
  /** Leading veg mark (white when pressed). */
  veg?: boolean;
}

export function FilterPill({ pressed, children, veg, className, type = 'button', ...rest }: FilterPillProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3.5 text-[13.5px] font-medium transition-all duration-150 [@media(pointer:coarse)]:min-h-touch',
        pressed ? 'border-pri bg-pri text-pri-fg' : 'border-line bg-card text-fg-2 hover:border-line-2 hover:text-fg',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {veg ? (
        <span aria-hidden="true" className="contents">
          <FoodMarker veg size={13} onColor={pressed} />
        </span>
      ) : null}
      {children}
    </button>
  );
}

export function PriceChips({ value, onChange, className }: { value: number[]; onChange: (bands: number[]) => void; className?: string }) {
  const toggle = (b: number) => onChange(value.includes(b) ? value.filter((x) => x !== b) : [...value, b].sort());
  return (
    <div role="group" aria-label="Price" className={cn('flex gap-1.5', className)}>
      {[1, 2, 3].map((b) => (
        <FilterPill key={b} pressed={value.includes(b)} onClick={() => toggle(b)} aria-label={`Price band ${'₹'.repeat(b)}`}>
          {'₹'.repeat(b)}
        </FilterPill>
      ))}
    </div>
  );
}

export interface ChoicePillsProps<T extends string> {
  label: string;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean }>;
  value: T | null | undefined;
  onChange: (v: T) => void;
  columns?: 2 | 3 | 4;
  className?: string;
}

export function ChoicePills<T extends string>({ label, options, value, onChange, columns = 4, className }: ChoicePillsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn('grid gap-1.5', columns === 2 ? 'grid-cols-2' : columns === 3 ? 'grid-cols-3' : 'grid-cols-4', className)}>
      {options.map((o) => {
        const pressed = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={pressed}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-11 rounded-control border px-2 text-sm font-medium transition-colors duration-150',
              pressed ? 'border-pri bg-pri text-pri-fg' : 'border-line bg-card text-fg hover:border-line-2',
              'disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
