/**
 * Modal dialog: portal, aria-modal, labelled by its title, described by its description, focus trapped,
 * Escape / overlay click close, focus restored to the trigger, body scroll locked. Bottom-anchored on
 * phones, centered on larger screens. Prefer inline UI first; use a dialog for confirmations and short,
 * focused tasks.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Edit item" description="Changes apply immediately"
 *     footer={<FormActions><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" form="item-form">Save</Button></FormActions>}>
 *     <form id="item-form" onSubmit={...}>…</form>
 *   </Dialog>
 *
 * `dismissible={false}` blocks Escape/overlay close (e.g. while a request is in flight).
 * <Sheet> (same file) is a side/bottom drawer with identical semantics.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { IconButton } from './Button';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), iframe, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && !el.closest('[inert]'));
}

let scrollLocks = 0;
function lockScroll(): () => void {
  if (scrollLocks++ === 0) document.body.style.overflow = 'hidden';
  return () => {
    if (--scrollLocks === 0) document.body.style.overflow = '';
  };
}

interface ModalBaseProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
  role?: 'dialog' | 'alertdialog';
  overlayClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}

function ModalBase({
  open, onClose, labelledBy, describedBy, ariaLabel, initialFocusRef, dismissible = true, role = 'dialog',
  overlayClassName, panelClassName, children,
}: ModalBaseProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    const panel = panelRef.current;
    if (panel) {
      const target =
        initialFocusRef?.current ??
        focusables(panel.querySelector<HTMLElement>('[data-dialog-body]') ?? panel)[0] ??
        focusables(panel)[0] ??
        panel;
      target.focus();
    }
    return () => {
      unlock();
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    };
    // Intentionally only re-run when `open` flips: focus moves in on open and back out on close.
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (dismissible) onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      e.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current || !panelRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex', overlayClassName)} onKeyDown={onKeyDown}>
      <div
        aria-hidden="true"
        className="absolute inset-0 animate-fade-in bg-slate-950/45"
        onClick={() => dismissible && onCloseRef.current()}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn('relative flex max-h-full flex-col bg-surface shadow-overlay focus:outline-none', panelClassName)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
  hideClose?: boolean;
  role?: 'dialog' | 'alertdialog';
}

const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' };

export function Dialog({
  open, onClose, title, description, children, footer, size = 'md', initialFocusRef, dismissible = true, hideClose, role,
}: DialogProps) {
  const id = useId().replace(/:/g, '');
  return (
    <ModalBase
      open={open}
      onClose={onClose}
      labelledBy={`dlg${id}-title`}
      describedBy={description ? `dlg${id}-desc` : undefined}
      initialFocusRef={initialFocusRef}
      dismissible={dismissible}
      role={role}
      overlayClassName="items-end justify-center sm:items-center sm:p-6"
      panelClassName={cn(
        'w-full animate-sheet-up rounded-t-[1.25rem] sm:animate-pop-in sm:rounded-card max-h-[92dvh] sm:max-h-[85dvh]',
        widths[size],
      )}
    >
      <div className="flex items-start gap-3 px-5 pt-5 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id={`dlg${id}-title`} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {description ? (
            <p id={`dlg${id}-desc`} className="mt-1 text-[0.9375rem] text-slate-600">
              {description}
            </p>
          ) : null}
        </div>
        {!hideClose && dismissible ? <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2 -mt-2" /> : null}
      </div>
      <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {children}
      </div>
      {footer ? (
        <div className="border-t border-slate-200 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">{footer}</div>
      ) : null}
    </ModalBase>
  );
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: 'bottom' | 'right' | 'left';
  children?: ReactNode;
  footer?: ReactNode;
  /** Visually hide the title (still labels the sheet). */
  hideTitle?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dismissible?: boolean;
}

const sheetSide = {
  bottom: { overlay: 'items-end', panel: 'w-full max-h-[90dvh] animate-sheet-up rounded-t-[1.25rem]' },
  right: { overlay: 'justify-end', panel: 'h-full w-[min(26rem,100%)] animate-sheet-right' },
  left: { overlay: 'justify-start', panel: 'h-full w-[min(20rem,88%)] animate-sheet-left' },
};

/** Drawer (cart drawer, mobile nav, filters). */
export function Sheet({ open, onClose, title, side = 'right', children, footer, hideTitle, initialFocusRef, dismissible = true }: SheetProps) {
  const id = useId().replace(/:/g, '');
  const s = sheetSide[side];
  return (
    <ModalBase
      open={open}
      onClose={onClose}
      labelledBy={`sh${id}-title`}
      initialFocusRef={initialFocusRef}
      dismissible={dismissible}
      overlayClassName={s.overlay}
      panelClassName={s.panel}
    >
      <div className={cn('flex items-center gap-3 px-5 pt-4', hideTitle ? 'justify-end' : 'justify-between pb-2')}>
        <h2 id={`sh${id}-title`} className={cn('text-lg font-semibold text-slate-900', hideTitle && 'sr-only')}>
          {title}
        </h2>
        {dismissible ? <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2" /> : null}
      </div>
      <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {children}
      </div>
      {footer ? <div className="border-t border-slate-200 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
    </ModalBase>
  );
}
