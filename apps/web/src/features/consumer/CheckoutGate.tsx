/**
 * "Checkout" entry used by the dock, tray, drawer and cart page: signed-in users go straight to the URL, guests
 * get the OTP sign-in dialog first (the guest cart is merged on verify) and then continue (10-35).
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../lib/auth';
import { LoginDialog } from './LoginDialog';

export function useCheckoutGate(): { go: (href: string) => void; dialog: ReactNode } {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const go = (href: string) => {
    if (isAuthenticated) navigate(href);
    else setPending(href);
  };
  const dialog = (
    <LoginDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      onSignedIn={() => {
        const href = pending;
        setPending(null);
        if (href) navigate(href);
      }}
    />
  );
  return { go, dialog };
}

export const checkoutHref = (restaurantId?: string) => (restaurantId ? `/checkout?restaurant=${encodeURIComponent(restaurantId)}` : '/checkout');
