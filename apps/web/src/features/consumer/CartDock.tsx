/**
 * Floating multi-cart bar + tray (board 10, design-spec §3.22, 10-33…10-42), wired to the server cart.
 *
 *   dock   avatars · "2 carts · 3 items" / "2 deliveries, one payment" (toggles the tray; hover opens it on a fine
 *          pointer, click pins it, Esc closes) · per-cart chips (open the tray on that cart) · "Checkout · ₹558 →"
 *   tray   tabs All carts / per restaurant · slots with optimistic − / + · "Checkout only {restaurant} →" (ORD-3)
 *   toast  "Added Double ka Meetha to Spice Route · hover to see all carts" for 4.5 s after an add
 * ≤640: full-width bar, chips hidden (sm breakpoint), the tray opens as a bottom sheet. Hidden while the cart is empty.
 * The foundation `CartDock` renders the chips as static labels (no click), so the bar is composed here.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, CartTray, hueFor, Icon, Sheet, ToastPill } from '../../components/ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { formatINR, plural } from '../../lib/format';
import { useCart } from './api';
import { CartGroupSlot } from './CartLines';
import { useDeliveryLabel, useLastAdded } from './cartState';
import { checkoutHref, useCheckoutGate } from './CheckoutGate';

const rupees = (p: number) => formatINR(p).replace(/\.00$/, '');

export function CartDock({ className }: { className?: string }) {
  const cart = useCart();
  const c = cart.data;
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [tab, setTab] = useState<string>('all');
  const trayId = useId();
  const phone = useMediaQuery('(max-width: 640px)', false);
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)', false);
  const last = useLastAdded();
  const label = useDeliveryLabel();
  const { go, dialog } = useCheckoutGate();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = c?.groups ?? [];
  const activeTab = tab === 'all' || groups.some((g) => g.restaurantId === tab) ? tab : 'all';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  if (!c || c.itemCount <= 0) return dialog;

  const n = groups.length;
  const title = `${plural(n, 'cart')} · ${plural(c.itemCount, 'item')}`;
  const sub = n > 1 ? `${n} deliveries, one payment` : `Delivered by ${groups[0]!.restaurantName}`;
  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  const openOn = (id: string) => {
    setTab(id);
    setOpen(true);
    setPinned(true);
  };
  const shown = activeTab === 'all' ? groups : groups.filter((g) => g.restaurantId === activeTab);

  const tray = (
    <CartTray
      carts={groups.map((g) => ({ id: g.restaurantId, name: g.restaurantName, hue: hueFor(g.restaurantId), itemCount: g.itemCount }))}
      activeId={activeTab}
      onSelect={(id) => {
        setTab(id);
        setPinned(true);
      }}
      onClose={close}
    >
      {shown.map((g) => (
        <CartGroupSlot
          key={g.restaurantId}
          group={g}
          deliveryLabel={label(g.restaurantId, groups.indexOf(g) + 1)}
          action={
            n > 1 ? (
              <button
                type="button"
                onClick={() => go(checkoutHref(g.restaurantId))}
                className="inline-flex h-9 items-center self-start rounded-pill border border-line bg-card px-3.5 text-[13px] font-semibold text-fg hover:border-line-2"
              >
                Checkout only {g.restaurantName} →
              </button>
            ) : null
          }
        />
      ))}
    </CartTray>
  );

  return (
    <>
      <div
        className={cn(
          'pointer-events-none sticky bottom-5 z-20 flex justify-center px-4 pb-5 max-sm:bottom-14 max-sm:px-3 max-sm:pb-[max(12px,env(safe-area-inset-bottom))]',
          className,
        )}
      >
        <div
          className="pointer-events-auto flex w-full max-w-[760px] flex-col gap-2.5"
          onMouseEnter={() => {
            if (!finePointer || phone) return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            setOpen(true);
          }}
          onMouseLeave={() => {
            if (!finePointer || phone || pinned) return;
            hoverTimer.current = setTimeout(() => setOpen(false), 200);
          }}
        >
          {open && !phone ? (
            <div id={trayId} className="origin-bottom animate-tray">
              {tray}
            </div>
          ) : null}
          <div className="on-color flex animate-dock items-center gap-2.5 rounded-pill bg-fg py-2 pl-2.5 pr-2 text-bg shadow-float dark:border dark:border-line-2 dark:bg-card dark:text-fg">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={trayId}
              onClick={() => {
                if (open && pinned) close();
                else {
                  setOpen(true);
                  setPinned(true);
                }
              }}
              className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-pill px-1.5 text-left"
            >
              <span className="flex shrink-0 pl-2" aria-hidden="true">
                {groups.slice(0, 3).map((g) => (
                  <Avatar key={g.restaurantId} name={g.restaurantName} hue={hueFor(g.restaurantId)} size={32} className="-ml-2 border-2 border-fg text-[11px] dark:border-card" />
                ))}
              </span>
              <span className="flex min-w-0 flex-col items-start">
                <span key={c.itemCount} className="animate-bump truncate text-[14.5px] font-semibold" aria-live="polite">
                  {title}
                </span>
                <span className="max-w-full truncate text-xs opacity-65">{sub}</span>
              </span>
              <Icon name="chevron-up" size={16} className={cn('shrink-0 opacity-70 transition-transform duration-200', open && 'rotate-180')} />
            </button>
            <ul className="hidden items-center gap-1.5 sm:flex" aria-label="Carts">
              {groups.map((g) => (
                <li key={g.restaurantId}>
                  <button
                    type="button"
                    onClick={() => openOn(g.restaurantId)}
                    className="inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-pill border border-[color-mix(in_srgb,var(--bg)_28%,transparent)] px-3 text-[12.5px] font-medium dark:border-line-2"
                  >
                    <span aria-hidden="true" className="size-[7px] rounded-[2px]" style={{ background: hueFor(g.restaurantId) }} />
                    {g.restaurantName} · {rupees(g.subtotalPaise)}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => go(checkoutHref())}
              className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-pill bg-pri px-[18px] text-sm font-semibold text-pri-fg hover:bg-pri-h"
            >
              Checkout · {rupees(c.subtotalPaise)}
              <Icon name="arrow-right" size={15} />
            </button>
          </div>
          {last ? (
            <div className="flex justify-center">
              <ToastPill tone="success">
                Added {last.itemName} to {last.restaurantName} · {finePointer ? 'hover' : 'tap'} to see all carts
              </ToastPill>
            </div>
          ) : null}
        </div>
      </div>
      {phone ? (
        <Sheet open={open} onClose={close} title="Your carts" side="bottom" footer={
          <button type="button" onClick={() => go(checkoutHref())} className="inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-pill bg-pri text-[15px] font-semibold text-pri-fg">
            Checkout · {rupees(c.subtotalPaise)}
          </button>
        }>
          {tray}
        </Sheet>
      ) : null}
      {dialog}
    </>
  );
}
