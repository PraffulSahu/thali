/**
 * Restaurant area routes. OWNED BY THE RESTAURANT AREA IMPLEMENTER: replace the placeholder.
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
      <PageHeader title="Restaurant dashboard" description="Orders, menu, store hours and payouts for your restaurant." />
      <EmptyState icon="store" title="Coming together" description="This area is being built on the shared foundation." />
    </>
  );
}

export const nav: NavItem[] = [
  { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
  { to: '/restaurant/orders', label: 'Orders', icon: 'receipt' },
  { to: '/restaurant/menu', label: 'Menu', icon: 'list' },
  { to: '/restaurant/settings', label: 'Store settings', icon: 'settings' },
  { to: '/restaurant/finance', label: 'Finance', icon: 'wallet' },
];

export const routes: RouteObject[] = [
  { index: true, element: <Placeholder /> },
  { path: '*', element: <NotFoundPage home="/restaurant" /> },
];
