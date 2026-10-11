/**
 * Cart drawer (11-04; design-spec §7.2): right sheet 440px (bottom sheet on phones) with one tray slot per
 * restaurant, items subtotal and "Proceed to checkout" (guests sign in first). "Open full cart" → /cart.
 */
import { Button, ButtonLink, ErrorState, Price, Sheet, Skeleton } from '../../components/ui';
import { EmptyCart } from './parts';
import { useCart } from './api';
import { CartGroupSlot } from './CartLines';
import { useDeliveryLabel } from './cartState';
import { useAuth } from '../../lib/auth';
import { checkoutHref, useCheckoutGate } from './CheckoutGate';

/**
 * `onCheckout(href)` lets the owner (header CartButton) run the guest sign-in gate OUTSIDE the drawer, so the
 * sign-in dialog survives the drawer closing. Without it the drawer gates itself and stays open for guests
 * (closing it would unmount the dialog with it).
 */
export function CartDrawer({ open, onClose, onCheckout }: { open: boolean; onClose: () => void; onCheckout?: (href: string) => void }) {
  const cart = useCart();
  const label = useDeliveryLabel();
  const { isAuthenticated } = useAuth();
  const own = useCheckoutGate();
  const dialog = onCheckout ? null : own.dialog;
  const checkout = (href: string) => {
    if (onCheckout) {
      onClose();
      onCheckout(href);
    } else {
      if (isAuthenticated) onClose();
      own.go(href);
    }
  };
  const c = cart.data;
  const many = (c?.groups.length ?? 0) > 1;
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Your cart"
        side="right"
        footer={
          c && c.groups.length ? (
            <div className="flex w-full flex-col gap-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-medium">Items subtotal</span>
                <Price paise={c.subtotalPaise} size="xl" />
              </div>
              <p className="text-xs text-fg-3">Fees and taxes are shown per restaurant at checkout. One payment covers every cart.</p>
              <Button
                size="lg"
                fullWidth
                onClick={() => checkout(checkoutHref())}
              >
                Proceed to checkout
              </Button>
              <ButtonLink to="/cart" variant="outline" fullWidth onClick={onClose}>
                Open full cart
              </ButtonLink>
            </div>
          ) : undefined
        }
      >
        {cart.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : cart.isError ? (
          <ErrorState compact error={cart.error} title="Couldn't load your cart" onRetry={() => void cart.refetch()} />
        ) : !c || c.groups.length === 0 ? (
          <EmptyCart onBrowse={onClose} compact />
        ) : (
          <div className="flex flex-col gap-3">
            {many ? <p className="text-[13px] text-fg-3">{c.deliveryExplanation ?? 'Each restaurant cooks and delivers its part separately.'}</p> : null}
            {c.groups.map((g, i) => (
              <div key={g.restaurantId} className="overflow-hidden rounded-card border border-line bg-card [&>div]:border-r-0 [&>div]:border-b-0">
                <CartGroupSlot
                  group={g}
                  deliveryLabel={label(g.restaurantId, i + 1)}
                  linkName
                  action={
                    many ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => checkout(checkoutHref(g.restaurantId))}
                      >
                        Checkout only {g.restaurantName} →
                      </Button>
                    ) : null
                  }
                />
              </div>
            ))}
          </div>
        )}
      </Sheet>
      {dialog}
    </>
  );
}

export default CartDrawer;
