/**
 * Partner area routes (mounted at /partner/*, guard: DELIVERY_PARTNER; /partner/onboarding* needs sign-in only).
 */
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';

const page = <T extends { default: React.ComponentType }>(load: () => Promise<T>) => ({ lazy: () => load().then((m) => ({ Component: m.default })) });

export const nav: NavItem[] = [
  { to: '/partner', label: 'Home', icon: 'home', end: true },
  { to: '/partner/history', label: 'History', icon: 'clock' },
  { to: '/partner/earnings', label: 'Earnings', icon: 'wallet' },
];

export const routes: RouteObject[] = [
  { index: true, ...page(() => import('./PartnerHome')) },
  { path: 'onboarding', ...page(() => import('./PartnerOnboarding')) },
  { path: 'history', ...page(() => import('./HistoryPage')) },
  { path: 'earnings', ...page(() => import('./EarningsPage')) },
  { path: '*', element: <NotFoundPage home="/partner" /> },
];
