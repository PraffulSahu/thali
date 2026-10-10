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
import { Icon, type IconName } from './Icon';

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

const toneStyle: Record<ToastTone, { icon: IconName; iconClass: string }> = {
  neutral: { icon: 'info', iconClass: 'text-slate-500' },
  info: { icon: 'info', iconClass: 'text-info-700' },
  success: { icon: 'check', iconClass: 'text-success-700' },
  warn: { icon: 'alert', iconClass: 'text-warn-700' },
  danger: { icon: 'alert', iconClass: 'text-danger-700' },
};

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
      className="pointer-events-auto flex w-full max-w-sm animate-pop-in items-start gap-3 rounded-card border border-slate-200 bg-surface p-4 shadow-overlay"
    >
      <Icon name={s.icon} size={20} className={cn('mt-0.5', s.iconClass)} />
      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] font-semibold text-slate-900">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-sm text-slate-600">{item.description}</p> : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
            className="mt-2 text-sm font-semibold text-brand-700 hover:underline"
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-m-2 grid size-touch shrink-0 place-items-center rounded-control text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
