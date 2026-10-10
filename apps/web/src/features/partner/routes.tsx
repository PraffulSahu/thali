/**
 * Partner area routes. OWNED BY THE PARTNER AREA IMPLEMENTER: replace the placeholder.
 * Contract (see src/README-FOUNDATION.md "Role areas"): export `routes` (paths relative to the area root,
 * index = area home, keep a '*' NotFound), optional `nav`, `HeaderActions`, `wide`.
 * Lazy-load pages: { path: 'orders', lazy: () => import('./OrdersPage').then((m) => ({ Component: m.default })) }
 */
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';

function Placeholder() {
  return (
    <>
      <PageHeader title="Partner home" description="Go online, take delivery offers and track your earnings." />
      <EmptyState icon="bike" title="Coming together" description="This area is being built on the shared foundation." />
    </>
  );
}

export const nav: NavItem[] = [
  { to: '/partner', label: 'Home', icon: 'home', end: true },
  { to: '/partner/history', label: 'History', icon: 'clock' },
  { to: '/partner/earnings', label: 'Earnings', icon: 'wallet' },
];

export const routes: RouteObject[] = [
  { index: true, element: <Placeholder /> },
  { path: '*', element: <NotFoundPage home="/partner" /> },
];
