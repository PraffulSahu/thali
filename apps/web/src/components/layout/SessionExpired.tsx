/**
 * Global "Session expired — sign in again" dialog. Mounted once in the root layout; opens when `api()`
 * reports that a signed-in session could not be refreshed (lib/api `onSessionExpired`). "Sign in again"
 * goes to the area's sign-in page with `next` = the current route, so the user returns where they were.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { onSessionExpired } from '../../lib/api';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormActions } from '../ui/FormActions';

export function signInPathFor(pathname: string): string {
  return pathname.startsWith('/admin') ? '/admin/login' : '/signin';
}

export function SessionExpiredDialog() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => onSessionExpired(() => setOpen(true)), []);

  // Signing in elsewhere (or landing on a sign-in page) closes it.
  useEffect(() => {
    if (location.pathname === '/signin' || location.pathname.startsWith('/admin/login')) setOpen(false);
  }, [location.pathname]);

  const signIn = () => {
    setOpen(false);
    const next = encodeURIComponent(location.pathname + location.search);
    navigate(`${signInPathFor(location.pathname)}?next=${next}`);
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Session expired — sign in again"
      description="For your security you were signed out. Sign in again to pick up where you left off."
      size="sm"
      role="alertdialog"
      footer={
        <FormActions>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Not now
          </Button>
          <Button onClick={signIn}>Sign in again</Button>
        </FormActions>
      }
    />
  );
}
