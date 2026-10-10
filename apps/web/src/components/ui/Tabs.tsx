/**
 * Accessible tabs (WAI-ARIA: roving tabindex, Left/Right/Home/End). Controlled or uncontrolled.
 *
 *   <Tabs label="Order status" tabs={[
 *     { id: 'new', label: 'New', count: 3, content: <NewOrders /> },
 *     { id: 'preparing', label: 'Preparing', content: <Preparing /> },
 *   ]} />
 *   <Tabs value={tab} onChange={setTab} tabs={…} />   // e.g. synced with ?tab= in the URL
 *
 * For tabs that are separate routes, use NavLinks instead (navigation, not tabs).
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, label, value, defaultValue, onChange, className }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.id ?? '');
  const active = value ?? internal;
  const id = useId().replace(/:/g, '');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (next: string) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.id === active);
    let next: TabItem | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1 [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab${id}-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel${id}-${t.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              className={cn(
                'relative -mb-px inline-flex min-h-touch items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[0.9375rem] font-medium transition-colors duration-150',
                selected ? 'border-brand-600 text-slate-900' : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {t.label}
              {t.count !== undefined ? (
                <span
                  className={cn(
                    'min-w-6 rounded-pill px-1.5 text-center text-xs font-semibold tabular-nums',
                    selected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700',
                  )}
                >
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`panel${id}-${t.id}`}
          aria-labelledby={`tab${id}-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="pt-4 focus-visible:outline-offset-4"
        >
          {t.id === active ? t.content : null}
        </div>
      ))}
    </div>
  );
}
