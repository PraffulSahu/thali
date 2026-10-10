/**
 * Admin area routes (mounted at `/admin/*` behind the ADMIN + MFA guard; `/admin/login` is public).
 * Pages are lazy-loaded so the Leaflet map and editors only load when needed.
 */
import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';

const page = (load: () => Promise<{ default: React.ComponentType }>) => () => load().then((m) => ({ Component: m.default }));

export const routes: RouteObject[] = [
  { path: 'login', lazy: page(() => import('./AdminLogin')) },
  { index: true, lazy: page(() => import('./OverviewPage')) },
  { path: 'approvals', element: <Navigate to="/admin/restaurants?status=APPROVAL_PENDING" replace /> },
  { path: 'restaurants', lazy: page(() => import('./RestaurantsApprovals')) },
  { path: 'restaurants/:id', lazy: page(() => import('./RestaurantDetail')) },
  { path: 'partners', lazy: page(() => import('./PartnersApprovals')) },
  { path: 'partners/:id', lazy: page(() => import('./PartnerDetail')) },
  { path: 'users', lazy: page(() => import('./UsersPage')) },
  { path: 'orders', lazy: page(() => import('./OrdersSearch')) },
  { path: 'orders/:checkoutId', lazy: page(() => import('./OrderInvestigation')) },
  { path: 'tms', lazy: page(() => import('./TmsPage')) },
  { path: 'catalog', lazy: page(() => import('./CatalogPage')) },
  { path: 'support', lazy: page(() => import('./SupportQueue')) },
  { path: 'support/:id', lazy: page(() => import('./TicketDetail')) },
  { path: 'finance', lazy: page(() => import('./FinancePage')) },
  { path: 'audit', lazy: page(() => import('./AuditLogPage')) },
  { path: 'health', lazy: page(() => import('./HealthPage')) },
  { path: '*', element: <NotFoundPage home="/admin" /> },
];

export const nav: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'chart', end: true },
  { to: '/admin/restaurants', label: 'Restaurants', icon: 'store' },
  { to: '/admin/partners', label: 'Partners', icon: 'bike' },
  { to: '/admin/orders', label: 'Orders', icon: 'receipt' },
  { to: '/admin/tms', label: 'Deliveries', icon: 'map' },
  { to: '/admin/support', label: 'Support', icon: 'ticket' },
  { to: '/admin/users', label: 'Users', icon: 'users' },
  { to: '/admin/catalog', label: 'Catalog', icon: 'list' },
  { to: '/admin/finance', label: 'Finance', icon: 'wallet' },
  { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
  { to: '/admin/health', label: 'Health', icon: 'activity' },
];

export const wide = false;
