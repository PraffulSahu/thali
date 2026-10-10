/**
 * Cart quick-view drawer (opened from the header cart button in HeaderActions.tsx): per-restaurant groups
 * (each "Delivered separately"), subtotal, and links to the full cart / checkout (sign-in first for guests).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, ButtonLink, EmptyState, Price, Sheet, Skeleton } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { useCart } from './api';
import { CartGroups } from './CartPage';
import { LoginDialog } from './LoginDialog';

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cart = useCart();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [login, setLogin] = useState(false);
  const c = cart.data;
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Your cart"
        side="right"
        footer={
          c && c.groups.length ? (
            <div className="w-full space-y-2">
              <div className="flex justify-between font-semibold">
                <span>Items subtotal</span>
                <Price paise={c.subtotalPaise} />
              </div>
              <p className="text-xs text-slate-600">Fees and taxes are calculated per restaurant at checkout.</p>
              {isAuthenticated ? (
                <ButtonLink to="/checkout" fullWidth onClick={onClose}>
                  Checkout
                </ButtonLink>
              ) : (
                <Button fullWidth onClick={() => setLogin(true)}>
                  Sign in to checkout
                </Button>
              )}
              <ButtonLink to="/cart" variant="secondary" fullWidth onClick={onClose}>
                Open full cart
              </ButtonLink>
            </div>
          ) : undefined
        }
      >
        {cart.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : cart.isError ? (
          <div className="space-y-2 text-sm text-danger-800" role="alert">
            <p>Couldn&rsquo;t load your cart: {errorMessage(cart.error)}</p>
            <Button size="sm" variant="secondary" onClick={() => void cart.refetch()}>
              Retry
            </Button>
          </div>
        ) : !c || c.groups.length === 0 ? (
          <EmptyState compact icon="cart" title="Your cart is empty" description="Add dishes from any restaurant that delivers to you." />
        ) : (
          <CartGroups cart={c} compact />
        )}
      </Sheet>
      <LoginDialog
        open={login}
        onClose={() => setLogin(false)}
        onSignedIn={() => {
          onClose();
          navigate('/checkout');
        }}
      />
    </>
  );
}

export default CartDrawer;
