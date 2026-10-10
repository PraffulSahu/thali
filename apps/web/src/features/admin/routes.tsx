/**
 * Admin area routes. OWNED BY THE ADMIN AREA IMPLEMENTER: replace the placeholder.
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
      <PageHeader title="Admin overview" description="Approvals, orders, deliveries, finance and platform health." />
      <EmptyState icon="shield" title="Coming together" description="This area is being built on the shared foundation." />
    </>
  );
}

export const nav: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'chart', end: true },
  { to: '/admin/approvals', label: 'Approvals', icon: 'check' },
  { to: '/admin/orders', label: 'Orders', icon: 'receipt' },
  { to: '/admin/tms', label: 'Deliveries', icon: 'bike' },
  { to: '/admin/finance', label: 'Finance', icon: 'wallet' },
  { to: '/admin/health', label: 'Health', icon: 'activity' },
];

export const routes: RouteObject[] = [
  { index: true, element: <Placeholder /> },
  { path: '*', element: <NotFoundPage home="/admin" /> },
];
