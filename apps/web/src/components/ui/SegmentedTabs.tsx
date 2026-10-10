/**
 * Segmented control (design-spec §3.4): pill track in --muted, the selected segment lifts onto --card.
 *
 *   // Sign-in role tabs (aria-pressed buttons in a labelled group)
 *   <SegmentedTabs label="Sign in as" value={role} onChange={setRole} fullWidth
 *     options={[{ value: 'customer', label: 'Customer' }, { value: 'restaurant', label: 'Restaurant' }, ...]} />
 *   // Kanban on phones / cart tray (real tabs: pair with your own role="tabpanel" + `idPrefix`)
 *   <SegmentedTabs semantics="tabs" idPrefix="kanban" size="sm" label="Order status" value={col} onChange={setCol}
 *     options={[{ value: 'new', label: 'New', count: 1 }, { value: 'prep', label: 'Preparing', count: 2 }]} />
 *
 * `semantics`: 'pressed' (default; group + aria-pressed) · 'tabs' (tablist/tab/aria-selected, panels are
 * `${idPrefix}-panel-${value}`) · 'radio' (radiogroup/radio/aria-checked). Arrow keys / Home / End move.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
  icon?: IconName;
  /** 8px square colour swatch (cart tray tabs: restaurant hue). */
  swatch?: string;
  disabled?: boolean;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
}

export interface SegmentedTabsProps<T extends string = string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  semantics?: 'pressed' | 'tabs' | 'radio';
  /** md = 36px segments (role tabs) · sm = 30px (tray tabs, kanban) */
  size?: 'md' | 'sm';
  /** Equal-width segments filling the row. */
  fullWidth?: boolean;
  idPrefix?: string;
  className?: string;
}

export function SegmentedTabs<T extends string = string>({
  options, value, onChange, label, semantics = 'pressed', size = 'md', fullWidth, idPrefix, className,
}: SegmentedTabsProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = options.filter((o) => !o.disabled);
    const idx = enabled.findIndex((o) => o.value === value);
    let next: SegmentOption<T> | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    refs.current[next.value]?.focus();
  };
  const role = semantics === 'tabs' ? 'tablist' : semantics === 'radio' ? 'radiogroup' : 'group';
  return (
    <div
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'rounded-pill bg-fill p-[3px]',
        fullWidth ? 'grid' : 'inline-flex max-w-full overflow-x-auto no-scrollbar',
        size === 'md' ? 'gap-0.5' : 'gap-1',
        className,
      )}
      style={fullWidth ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((o) => {
        const selected = o.value === value;
        const stateProps =
          semantics === 'tabs'
            ? {
                role: 'tab',
                'aria-selected': selected,
                id: idPrefix ? `${idPrefix}-tab-${o.value}` : undefined,
                'aria-controls': idPrefix ? `${idPrefix}-panel-${o.value}` : undefined,
              }
            : semantics === 'radio'
              ? { role: 'radio', 'aria-checked': selected }
              : { 'aria-pressed': selected };
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[o.value] = el;
            }}
            type="button"
            {...stateProps}
            aria-label={o.ariaLabel}
            tabIndex={semantics === 'pressed' ? undefined : selected ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-pill transition-[background-color,color,box-shadow] duration-200',
              size === 'md' ? 'h-9 px-3 text-[13.5px] font-medium max-[360px]:text-[12.5px]' : 'h-[30px] px-3 text-[13px] font-medium',
              '[@media(pointer:coarse)]:min-h-touch',
              selected ? 'bg-card text-fg shadow-seg' : 'text-fg-3 hover:text-fg',
              'disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            {o.swatch ? <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: o.swatch }} /> : null}
            {o.icon ? <Icon name={o.icon} size={14} /> : null}
            <span className="truncate">{o.label}</span>
            {o.count !== undefined ? <span className="font-mono text-[11px] tabular-nums opacity-70">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
