/**
 * Router root: global, router-aware singletons (session-expired dialog, scroll restoration, focus on
 * navigation). Area chrome lives in AppShell (rendered by AreaLayout in RoleArea.tsx).
 */
import { useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { SessionExpiredDialog } from './SessionExpired';

/** Move focus to <main> after client-side navigation so screen-reader users land on the new page. */
function FocusOnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}

export function RootLayout() {
  return (
    <>
      <Outlet />
      <SessionExpiredDialog />
      <FocusOnNavigate />
      <ScrollRestoration />
    </>
  );
}
