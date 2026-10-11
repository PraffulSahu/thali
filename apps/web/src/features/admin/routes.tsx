/**
 * Admin area routes (mounted at `/admin/*` behind the ADMIN + MFA guard). Sign-in + MFA live in the
 * foundation's unified `/signin?role=admin` (the router also redirects `/admin/login`).
 * Pages are lazy-loaded so the Leaflet map and editors only load when needed.
 */
import type { RouteObject } from 'react-router';
import { Navigate, useLocation } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';
import type { RoleShellConfig } from '../../components/layout/RoleSidebarShell';
import { AdminFooter, AdminMobileContext, AdminSearchContext, DeliveriesBadge, HealthBadge, PartnersBadge, RestaurantsBadge, SupportBadge } from './shell';

const page = (load: () => Promise<{ default: React.ComponentType }>) => () => load().then((m) => ({ Component: m.default }));

/** Any leftover `/admin/login?next=` link → the unified sign-in with the Admin tab. */
function LoginRedirect() {
  const next = new URLSearchParams(useLocation().search).get('next');
  return <Navigate to={`/signin?role=admin${next ? `&next=${encodeURIComponent(next)}` : ''}`} replace />;
}

export const routes: RouteObject[] = [
  { path: 'login/*', element: <LoginRedirect /> },
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

/** Board 40 sidebar: Overview, then MARKETPLACE / OPERATIONS / SYSTEM with live badges. Phone tabs = `primary`. */
export const nav: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'chart', end: true, primary: true },
  { to: '/admin/restaurants', label: 'Restaurants', icon: 'store', section: 'Marketplace', Badge: RestaurantsBadge, primary: true },
  { to: '/admin/partners', label: 'Partners', icon: 'bike', section: 'Marketplace', Badge: PartnersBadge },
  { to: '/admin/users', label: 'Users', icon: 'users', section: 'Marketplace' },
  { to: '/admin/catalog', label: 'Catalog', icon: 'list', section: 'Marketplace' },
  { to: '/admin/orders', label: 'Orders', icon: 'receipt', section: 'Operations', primary: true },
  { to: '/admin/tms', label: 'Deliveries', icon: 'map', section: 'Operations', Badge: DeliveriesBadge, primary: true },
  { to: '/admin/support', label: 'Support', icon: 'ticket', section: 'Operations', Badge: SupportBadge },
  { to: '/admin/finance', label: 'Finance', icon: 'wallet', section: 'Operations' },
  { to: '/admin/audit', label: 'Audit log', icon: 'shield', section: 'System' },
  { to: '/admin/health', label: 'Health', icon: 'activity', section: 'System', Badge: HealthBadge },
];

export const shell: RoleShellConfig = {
  Context: AdminSearchContext,
  MobileContext: AdminMobileContext,
  Footer: AdminFooter,
};

export const wide = false;
