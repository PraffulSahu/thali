/**
 * Consumer header controls (area `HeaderActions`): delivery-location chip + cart button with item count.
 * Kept light — the picker dialog and the cart drawer load on first open.
 */
import { lazy, Suspense, useState } from 'react';
import { useLocation } from 'react-router';
import { Icon } from '../../components/ui/Icon';
import { plural } from '../../lib/format';
import { useCart } from './api';
import { useChosenLocation } from './location';

const CartDrawer = lazy(() => import('./CartDrawer'));
const LocationDialog = lazy(() => import('./LocationPicker').then((m) => ({ default: m.LocationDialog })));

export function LocationChip() {
  const loc = useChosenLocation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-touch max-w-[7rem] items-center gap-1 rounded-control px-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 sm:max-w-[16rem] sm:gap-1.5 sm:px-2"
        aria-label={loc ? `Delivery location: ${loc.label}. Change` : 'Choose delivery location'}
      >
        <Icon name="location" size={18} className="shrink-0 text-brand-600" />
        <span className="truncate">{loc ? loc.label : 'Set location'}</span>
        <Icon name="chevron-down" size={14} className="hidden shrink-0 text-slate-500 sm:block" />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <LocationDialog open onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

export function CartButton() {
  const cart = useCart();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const count = cart.data?.itemCount ?? 0;
  const onCartPage = pathname === '/cart' || pathname.startsWith('/checkout');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={onCartPage}
        className="relative grid size-touch place-items-center rounded-control text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        aria-label={count ? `Cart, ${plural(count, 'item')}` : 'Cart, empty'}
      >
        <Icon name="cart" size={22} />
        {count ? (
          <span className="absolute right-0.5 top-0.5 inline-grid min-w-5 place-items-center rounded-pill bg-brand-600 px-1 text-[0.6875rem] font-bold leading-5 text-white" aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <CartDrawer open onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

export function ConsumerHeaderActions() {
  return (
    <>
      <LocationChip />
      <CartButton />
    </>
  );
}
