/**
 * Small building blocks the restaurant area needs that the foundation doesn't ship (listed as foundation gaps in
 * the Task 10 report): an anchored popover menu, the bell-off glyph, a mono "lbl" definition row.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Bell with a slash (Chime off) — same 24px grid and stroke as components/ui/Icon. */
export function BellOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="M8.7 3.6A6 6 0 0 1 18 8c0 3.6.8 5.8 1.6 7.1M17 17H3s3-2 3-9c0-.6.1-1.2.3-1.8M10 21h4M3 3l18 18" />
    </svg>
  );
}

export interface PopoverProps {
  /** Renders the trigger; spread `props` onto a <button>. */
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-controls': string; 'aria-haspopup': 'dialog' | 'menu' }) => ReactNode;
  children: (close: () => void) => ReactNode;
  /** Accessible name of the panel. */
  label: string;
  align?: 'start' | 'end';
  placement?: 'down' | 'up';
  className?: string;
  /** Size / padding of the panel. REPLACES the default `min-w-56 p-2` (no class-order overrides). */
  panelClassName?: string;
  role?: 'dialog' | 'menu';
}

/**
 * Anchored panel: opens under (or above) its trigger, closes on outside click / Escape (focus returns to the
 * trigger) and after an action calls `close()`. The first focusable element is focused when it opens.
 */
export function Popover({ trigger, children, label, align = 'end', placement = 'down', className, panelClassName = 'min-w-56 p-2', role = 'dialog' }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    (wrap.current?.querySelector('[aria-controls]') as HTMLElement | null)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button:not([disabled]),a[href],input,select,textarea')?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className={cn('relative', className)}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-controls': id, 'aria-haspopup': role })}
      {open ? (
        <div
          ref={panel}
          id={id}
          role={role}
          aria-label={label}
          className={cn(
            'absolute z-40 animate-pop-in rounded-card border border-line bg-card shadow-modal',
            align === 'end' ? 'right-0' : 'left-0',
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** Label / value row for money and detail panels (design-spec §7.1 money panels). */
export function DefRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm', className)}>
      <dt className="text-fg-3">{label}</dt>
      <dd className="text-right text-fg tabular-nums">{children}</dd>
    </div>
  );
}
