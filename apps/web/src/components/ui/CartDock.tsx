/**
 * Floating multi-cart bar (design-spec §3.22) — PRESENTATIONAL. The consumer area owns the cart data, the
 * open/pinned state and the checkout call; this renders the dock, the per-cart chips and the tray shell.
 *
 *   const [open, setOpen] = useState(false);
 *   <CartDock
 *     carts={groups.map((g) => ({ id: g.restaurantId, name: g.name, hue: hueFor(g.restaurantId), subtotalPaise: g.subtotal, itemCount: g.items }))}
 *     itemCount={cart.itemCount} totalPaise={cart.totalPaise}
 *     open={open} onOpenChange={setOpen}
 *     checkout={<ButtonLink to="/checkout" …/>}        // or omit and pass checkoutHref
 *     checkoutHref="/checkout"
 *     tray={<CartTray carts={…} activeId={tab} onSelect={setTab} onClose={() => setOpen(false)}>
 *             {groups.map((g) => <CartSlot key={g.id} … />)}
 *           </CartTray>}
 *     toast={lastAdded ? <ToastPill tone="success">Added to {lastAdded}</ToastPill> : null}
 *     onChipClick={(id) => { setTab(id); setOpen(true); }}   // chips become buttons (open the tray on that cart)
 *   />
 *
 * Light: ink dock on the page; dark: --card dock with a --line2 border. Hidden when `itemCount` is 0.
 * Behaviour (consumer area): hover opens on fine pointers, click pins, Esc closes; ≤640 → bottom sheet.
 */
import { useEffect, useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { Avatar, initials } from './Avatar';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { formatPaise } from './Price';
import { SegmentedTabs } from './SegmentedTabs';

export interface DockCart {
  id: string;
  name: string;
  hue: string;
  subtotalPaise: number;
  itemCount: number;
}

const rupees = (p: number) => formatPaise(p).replace(/\.00$/, '');

export interface CartDockProps {
  carts: DockCart[];
  itemCount: number;
  /** Shown on the checkout button ("Checkout · ₹558"). */
  totalPaise: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkoutHref?: string;
  /** Custom checkout control (replaces the default link). */
  checkout?: ReactNode;
  /** Tray content (usually <CartTray>), rendered above the dock while open. */
  tray?: ReactNode;
  /** Pill under/over the dock (e.g. <ToastPill>). */
  toast?: ReactNode;
  /** Override the sub line ("2 deliveries, one payment" / "Delivered by Spice Route"). */
  subtitle?: string;
  /** Per-cart chips (≥721px) become buttons calling this with the cart id (e.g. open the tray on that cart). */
  onChipClick?: (id: string) => void;
  className?: string;
}

export function CartDock({ carts, itemCount, totalPaise, open, onOpenChange, checkoutHref = '/checkout', checkout, tray, toast, subtitle, onChipClick, className }: CartDockProps) {
  const trayId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  if (itemCount <= 0) return null;
  const n = carts.length;
  const title = `${plural(n, 'cart')} · ${plural(itemCount, 'item')}`;
  const sub = subtitle ?? (n > 1 ? `${n} deliveries, one payment` : n === 1 ? `Delivered by ${carts[0]!.name}` : '');
  return (
    <div className={cn('pointer-events-none sticky bottom-5 z-20 flex justify-center px-4 pb-5 max-sm:bottom-0 max-sm:px-3 max-sm:pb-[max(12px,env(safe-area-inset-bottom))]', className)}>
      <div className="pointer-events-auto flex w-full max-w-[760px] flex-col gap-2.5">
        {open && tray ? (
          <div id={trayId} className="origin-bottom animate-tray">
            {tray}
          </div>
        ) : null}
        <div
          className={cn(
            'on-color flex animate-dock items-center gap-2.5 rounded-pill py-2 pl-2.5 pr-2 shadow-float',
            'bg-fg text-bg dark:border dark:border-line-2 dark:bg-card dark:text-fg',
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open && tray ? trayId : undefined}
            onClick={() => onOpenChange(!open)}
            className="flex h-11 min-w-0 items-center gap-3 rounded-pill px-1.5"
          >
            <span className="flex shrink-0 pl-2" aria-hidden="true">
              {carts.slice(0, 3).map((c) => (
                <Avatar key={c.id} name={c.name} hue={c.hue} size={32} className="-ml-2 border-2 border-fg text-[11px] dark:border-card" />
              ))}
            </span>
            <span className="flex min-w-0 flex-col items-start text-left">
              <span key={itemCount} className="animate-bump truncate text-[14.5px] font-semibold">{title}</span>
              {sub ? <span className="truncate text-xs opacity-65">{sub}</span> : null}
            </span>
            <Icon name="chevron-up" size={16} className={cn('shrink-0 opacity-70 transition-transform duration-200', open && 'rotate-180')} />
          </button>
          <ul className="ml-auto hidden items-center gap-1.5 min-[721px]:flex" aria-label="Carts">
            {carts.map((c) => {
              const chip = 'inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-pill border border-[color-mix(in_srgb,var(--bg)_28%,transparent)] px-3 text-[12.5px] font-medium dark:border-line-2';
              const body = (
                <>
                  <span aria-hidden="true" className="size-[7px] rounded-[2px]" style={{ background: c.hue }} />
                  {c.name} · {rupees(c.subtotalPaise)}
                </>
              );
              return (
                <li key={c.id}>
                  {onChipClick ? (
                    <button
                      type="button"
                      onClick={() => onChipClick(c.id)}
                      className={cn(chip, 'transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--bg)_12%,transparent)] dark:hover:bg-fill')}
                    >
                      {body}
                    </button>
                  ) : (
                    <span className={chip}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="ml-auto shrink-0 min-[721px]:ml-0">
            {checkout ?? (
              <Link
                to={checkoutHref}
                className="inline-flex h-11 items-center gap-2 rounded-pill bg-pri px-[18px] text-sm font-semibold text-pri-fg hover:bg-pri-h"
              >
                Checkout · {rupees(totalPaise)}
                <Icon name="arrow-right" size={15} />
              </Link>
            )}
          </div>
        </div>
        {toast ? <div className="flex justify-center">{toast}</div> : null}
      </div>
    </div>
  );
}

/** Tray filter buttons (All + per cart) are aria-pressed toggles: they filter the slots below, not tab panels. */
export interface CartTrayProps {
  carts: Array<Pick<DockCart, 'id' | 'name' | 'hue' | 'itemCount'>>;
  activeId: string | 'all';
  onSelect: (id: string | 'all') => void;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Tray card: tabs (All + per cart) · "Each cart is delivered separately" · close; body grid of slots; footer. */
export function CartTray({ carts, activeId, onSelect, onClose, children, footer }: CartTrayProps) {
  return (
    <section aria-label="Your carts" className="overflow-hidden rounded-card border border-line bg-card text-fg shadow-float">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-3">
        <SegmentedTabs
          size="sm"
          semantics="pressed"
          label="Show carts"
          value={activeId}
          onChange={onSelect}
          options={[
            { value: 'all', label: 'All', count: carts.reduce((n, c) => n + c.itemCount, 0) },
            ...carts.map((c) => ({ value: c.id, label: c.name, count: c.itemCount, swatch: c.hue })),
          ]}
        />
        <span className="text-[12.5px] text-fg-3 max-sm:hidden">Each cart is delivered separately</span>
        <IconButton icon="x" label="Close carts" size="xs" onClick={onClose} className="ml-auto" />
      </header>
      <div className="grid max-h-[340px] grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] overflow-auto">{children}</div>
      <footer className="flex items-start gap-2 bg-bg-2 px-4 py-2.5 text-[12.5px] text-fg-3">
        {footer ?? (
          <>
            <Icon name="info" size={14} className="mt-0.5 shrink-0" />
            Fees and taxes are shown per restaurant at checkout. One payment covers every cart.
          </>
        )}
      </footer>
    </section>
  );
}

export interface CartSlotProps {
  name: string;
  hue: string;
  /** "DELIVERY 1 · ~32 MIN EST." */
  deliveryLabel?: string;
  subtotalPaise: number;
  children: ReactNode;
  /** e.g. <ButtonLink variant="outline" size="sm" to="/checkout?restaurant=…">Checkout only Spice Route →</ButtonLink> */
  action?: ReactNode;
}

export function CartSlot({ name, hue, deliveryLabel, subtotalPaise, children, action }: CartSlotProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-r border-line px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-badge text-[11px] font-semibold"
          style={{ background: `color-mix(in srgb, ${hue} 18%, var(--card))`, color: hue }}
        >
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-sans text-[14.5px] font-semibold tracking-normal">{name}</h3>
          {deliveryLabel ? <p className="font-mono text-[11px] uppercase text-fg-3">{deliveryLabel}</p> : null}
        </div>
        <span className="text-[14.5px] font-semibold tabular-nums">{formatPaise(subtotalPaise)}</span>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
      {action}
    </div>
  );
}
