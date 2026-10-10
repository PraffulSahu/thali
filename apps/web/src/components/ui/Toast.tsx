/**
 * Transient notifications. <ToastProvider> is mounted once in App; call `useToast()` anywhere.
 *
 *   const { toast } = useToast();
 *   toast({ title: 'Order accepted', tone: 'success' });
 *   toast({ title: 'Taken by another partner', description: 'The offer was accepted by someone else.', tone: 'warn' });
 *   toast({ title: "Couldn't save", description: errorMessage(err), tone: 'danger' });
 *
 * Announced through persistent live regions (polite; danger toasts assertive); each non-danger toast is also
 * role="status". Auto-dismiss after 5 s
 * (danger 8 s, `duration: Infinity` to persist); hovering or focusing pauses the timer.
 * Use toasts for confirmations of things the user just did; persistent problems belong inline.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export type ToastTone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  toast(input: ToastInput): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const toast = useCallback((input: ToastInput) => {
    const id = nextId++;
    setItems((xs) => [...xs.slice(-3), { ...input, id }]);
    return id;
  }, []);
  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            // Live regions must exist BEFORE content is inserted or screen readers may miss it, so both are
            // always rendered (empty when there are no toasts). Danger toasts go to the assertive region.
            <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-end">
              <div aria-live="assertive" aria-relevant="additions text" className="flex w-full flex-col items-center gap-2 sm:items-end">
                {items.filter((t) => t.tone === 'danger').map((t) => (
                  <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
                ))}
              </div>
              <div aria-live="polite" aria-relevant="additions text" className="flex w-full flex-col items-center gap-2 sm:items-end">
                {items.filter((t) => t.tone !== 'danger').map((t) => (
                  <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

const toneStyle: Record<ToastTone, { dot: string }> = {
  neutral: { dot: 'bg-neu' },
  info: { dot: 'bg-info' },
  success: { dot: 'bg-ok' },
  warn: { dot: 'bg-warn' },
  danger: { dot: 'bg-bad' },
};

/**
 * Static toast pill (design-spec §3.33) for inline placements, e.g. under the cart dock:
 *   <ToastPill tone="success">Added to Spice Route</ToastPill>
 */
export function ToastPill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: ToastTone; className?: string }) {
  return (
    <span
      role="status"
      className={cn(
        'inline-flex animate-toast items-center gap-1.5 rounded-pill border border-line bg-card px-2.5 py-[5px] text-xs text-fg-2 shadow-card',
        className,
      )}
    >
      {tone !== 'neutral' ? <span aria-hidden="true" className={cn('size-1.5 rounded-full', toneStyle[tone].dot)} /> : null}
      {children}
    </span>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = item.tone ?? 'neutral';
  const duration = item.duration ?? (tone === 'danger' ? 8000 : 5000);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const started = useRef(Date.now());

  useEffect(() => {
    if (paused || !Number.isFinite(duration)) return;
    started.current = Date.now();
    const t = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current -= Date.now() - started.current;
    };
  }, [paused, duration, onDismiss]);

  const s = toneStyle[tone];
  return (
    <div
      // role="status" marks each toast semantically; announcement comes from the persistent live region above.
      // Danger toasts carry no role: the assertive region announces them (role="alert" would double-announce).
      role={tone === 'danger' ? undefined : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex w-full max-w-sm animate-pop-in items-start gap-2.5 rounded-field border border-line bg-card py-2.5 pl-3.5 pr-2 text-fg shadow-card"
    >
      <span aria-hidden="true" className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', s.dot)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-[13px] text-fg-3">{item.description}</p> : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
            className="mt-1.5 text-[13px] font-bold text-acc-fg hover:underline"
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="grid size-7 shrink-0 place-items-center rounded-pill text-fg-3 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:size-touch"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
