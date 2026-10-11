/**
 * Filter pills, price chips and choice pills (design-spec §3.5).
 *
 *   <FilterPill pressed={veg} onClick={() => setVeg(!veg)} veg>Veg only</FilterPill>
 *   <FilterPill pressed={openNow} onClick={toggleOpen}>Open now</FilterPill>
 *   <PriceChips value={bands} onChange={setBands} />                    // ₹ · ₹₹ · ₹₹₹ multi-select (1..3)
 *   <ChoicePills label="Prep time" value={prep} onChange={setPrep} columns={4}
 *     options={[{ value: '10', label: '10 min' }, …]} />               // 44px, 12px radius (owner prep/reject)
 *   <FilterPills label="Status" value={s} onChange={setS}
 *     options={[{ value: 'all', label: 'All' }, { value: 'PENDING', label: 'Pending', count: 3 }]} />   // single-select row, counts
 *   <PillSelect label="Status" prefix="Status:" value={s} onChange={setS} options={…} />                 // 30px outline pill over a native select
 */
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { FoodMarker, Icon } from './Icon';

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

/* ------------------------------------------------------------------ dense filter controls (admin board 40, §7.1 Filters) */

export interface PillSelectProps<T extends string> {
  label: string;
  /** Visible prefix ("Status:"); omit for value-only pills ("Today"). */
  prefix?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}

/** Outline pill (30px, board 40 "Status: All" / "Today") backed by a native select for keyboard + a11y. */
export function PillSelect<T extends string>({ label, prefix, value, options, onChange, className }: PillSelectProps<T>) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span
      className={cn(
        'relative inline-flex h-[30px] items-center gap-1.5 rounded-pill border border-line bg-card px-3 text-[12.5px] font-bold text-fg',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc hover:border-line-2 [@media(pointer:coarse)]:min-h-touch',
        className,
      )}
    >
      <span aria-hidden="true">{prefix ? `${prefix} ${current}` : current}</span>
      <Icon name="chevron-down" size={13} className="text-fg-3" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Status filter pills with optional counts (design-spec §7.1 Filters). */
export function FilterPills<T extends string>({
  label, options, value, onChange, className,
}: { label: string; options: { value: T; label: string; count?: number | null }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 no-scrollbar', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-[13px] font-medium transition-colors duration-150 [@media(pointer:coarse)]:min-h-touch',
            o.value === value ? 'border-pri bg-pri text-pri-fg' : 'border-line bg-card text-fg-2 hover:border-line-2 hover:text-fg',
          )}
        >
          {o.label}
          {typeof o.count === 'number' ? (
            <span className={cn('font-mono text-[11px]', o.value === value ? 'text-pri-fg/80' : 'text-fg-3')}>{o.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
