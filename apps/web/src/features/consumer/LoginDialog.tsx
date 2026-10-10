/**
 * Phone-OTP sign-in in a dialog (PRD C-5/C-6). Wraps the shared OtpSignInForm (normalization, 30 s resend
 * countdown, OTP_ATTEMPTS_EXCEEDED / RATE_LIMITED + Retry-After handling). `signInWithOtp` sends the guest cart
 * token on verify and falls back to `POST /cart/merge`, so the guest cart survives sign-in; afterwards we
 * refresh the cart query and continue (e.g. to checkout).
 */
import { useQueryClient } from '@tanstack/react-query';
import { OtpSignInForm } from '../../components/auth/OtpSignInForm';
import { Dialog } from '../../components/ui';
import type { AuthUser } from '../../lib/auth';
import { CART_KEY } from './api';

export interface LoginDialogProps {
  open: boolean;
  onClose: () => void;
  onSignedIn?: (user: AuthUser) => void;
  reason?: string;
}

export function LoginDialog({ open, onClose, onSignedIn, reason }: LoginDialogProps) {
  const qc = useQueryClient();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Sign in"
      description={reason ?? 'Sign in with your phone number to place your order. Your cart is kept.'}
      size="sm"
    >
      <OtpSignInForm
        onSuccess={(user) => {
          void qc.invalidateQueries({ queryKey: CART_KEY });
          onClose();
          onSignedIn?.(user);
        }}
      />
    </Dialog>
  );
}
