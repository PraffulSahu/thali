/**
 * Checkout shell (board 12; design-spec §3.28): not sticky, max-width 1160px. Back button · logo ·
 * "/ Checkout" · right: lock + "Secure checkout" · theme. No search, no cart.
 *
 *   // consumer routes (with `export const chrome = 'none'` or per-route layout):
 *   { element: <CheckoutShell backTo="/cart" />, children: [{ path: 'checkout', element: page(CheckoutPage) }] }
 *   <CheckoutShell title="Payment">…</CheckoutShell>
 */
import type { ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { IconButton } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Logo } from './Logo';
import { ModeBanner } from './ModeBanner';
import { MainRegion, SkipLink } from './ShellParts';

export interface CheckoutShellProps {
  /** Where the back button goes (default: browser back, falling back to /cart). */
  backTo?: string;
  title?: string;
  children?: ReactNode;
}

export function CheckoutShell({ backTo, title = 'Checkout', children }: CheckoutShellProps) {
  const navigate = useNavigate();
  const back = () => {
    if (backTo) navigate(backTo);
    else if (window.history.length > 1) navigate(-1);
    else navigate('/cart');
  };
  return (
    <div className="flex min-h-dvh flex-col page-glow">
      <SkipLink />
      <ModeBanner />
      <header className="mx-auto flex w-full max-w-[1160px] items-center gap-4 px-6 py-3 max-sm:gap-2 max-sm:px-4">
        <IconButton icon="chevron-left" label="Back" variant="outline" onClick={back} />
        <Logo to="/discover" />
        <span className="text-sm text-fg-3" aria-hidden="true">
          / {title}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-3">
            <Icon name="lock" size={14} />
            <span className="max-sm:sr-only">Secure checkout</span>
          </span>
          <ThemeToggle />
        </div>
      </header>
      <MainRegion className="pb-10 max-lg:pb-28">
        <div className="mx-auto w-full max-w-[1160px] px-6 pt-4 max-sm:px-4">{children ?? <Outlet />}</div>
      </MainRegion>
    </div>
  );
}
