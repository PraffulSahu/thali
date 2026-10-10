/**
 * Consumer area routes. OWNED BY THE CONSUMER AREA IMPLEMENTER: replace the placeholder.
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
      <PageHeader title="Order food" description="Discover restaurants that deliver to you." />
      <EmptyState icon="store" title="Coming together" description="This area is being built on the shared foundation." />
    </>
  );
}

export const nav: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/cart', label: 'Cart', icon: 'cart' },
  { to: '/orders', label: 'Orders', icon: 'receipt' },
  { to: '/account', label: 'Account', icon: 'user' },
];

export const routes: RouteObject[] = [
  { index: true, element: <Placeholder /> },
  { path: '*', element: <NotFoundPage home="/" /> },
];
