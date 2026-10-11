/**
 * Anchored popover panel (menus, small forms: "Change prep time", "Pause orders", the restaurant switcher).
 *
 *   <Popover
 *     label="Pause new orders"                       // accessible name of the panel
 *     panelClassName="w-[320px] p-3"                 // merged over the defaults (min-w-56 p-2) — later wins
 *     trigger={(p) => <Button variant="outline" {...p}>Pause orders</Button>}
 *   >
 *     {(close) => <PauseChoices onDone={close} />}
 *   </Popover>
 *
 * Behaviour: the trigger toggles it; on open the first focusable element in the panel gets focus (else the panel);
 * Escape closes and returns focus to the trigger; a pointer-down outside or focus moving out of it (Tab) closes it.
 * `placement`: down (default) · up · right (tablet rail). `align`: end (default, right edges) · start.
 * Controlled use: pass `open` + `onOpenChange`.
 */
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PopoverTriggerProps {
  onClick: () => void;
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-haspopup': 'dialog' | 'menu';
}

export interface PopoverProps {
  /** Renders the trigger; spread `props` onto a <button> (or a Button / IconButton). */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Panel content; the function form gets `close()` (returns focus to the trigger). */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name of the panel. */
  label: string;
  align?: 'start' | 'end';
  placement?: 'down' | 'up' | 'right';
  role?: 'dialog' | 'menu';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Wrapper (positioning context) classes. */
  className?: string;
  /** Panel classes, merged over the defaults with cn(): `w-[300px] p-3`, `right-0` (trigger width)… */
  panelClassName?: string;
}

const PLACEMENT = {
  down: 'top-full mt-2',
  up: 'bottom-full mb-2',
  right: 'left-full top-0 ml-2',
} as const;

const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Popover({
  trigger,
  children,
  label,
  align = 'end',
  placement = 'down',
  role = 'dialog',
  open: openProp,
  onOpenChange,
  className,
  panelClassName,
}: PopoverProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );
  const focusTrigger = useCallback(() => {
    wrap.current?.querySelector<HTMLElement>(`[aria-controls="${id}"]`)?.focus();
  }, [id]);
  const close = useCallback(() => {
    setOpen(false);
    focusTrigger();
  }, [setOpen, focusTrigger]);

  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const onDown = (e: PointerEvent | MouseEvent) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    // Only when focus really moves somewhere else (Tab); clicks on non-focusable panel areas have no relatedTarget.
    if (open && next && wrap.current && !wrap.current.contains(next)) setOpen(false);
  };

  return (
    <div ref={wrap} className={cn('relative', className)} onBlur={onBlur}>
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-controls': id, 'aria-haspopup': role })}
      {open ? (
        <div
          ref={panel}
          id={id}
          role={role}
          aria-label={label}
          tabIndex={-1}
          className={cn(
            'absolute z-40 min-w-56 animate-pop-in rounded-card border border-line bg-card p-2 text-left shadow-modal focus:outline-none',
            placement === 'right' ? '' : align === 'end' ? 'right-0' : 'left-0',
            PLACEMENT[placement],
            panelClassName,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}
