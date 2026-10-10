/**
 * Partner area routes (mounted at /partner/*, guard: DELIVERY_PARTNER; /partner/onboarding* needs sign-in only).
 * Chrome: RoleSidebarShell (PARTNER) via the `nav` + `shell` exports (board 30).
 */
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { RoleShellConfig } from '../../components/layout/RoleSidebarShell';
import type { NavItem } from '../../components/layout/RoleNav';
import { PartnerMobileContext, PartnerProfileCard, PartnerStatusFooter } from './PartnerShellParts';

const page = <T extends { default: React.ComponentType }>(load: () => Promise<T>) => ({ lazy: () => load().then((m) => ({ Component: m.default })) });

export const nav: NavItem[] = [
  { to: '/partner', label: 'Home', icon: 'home', end: true, primary: true },
  { to: '/partner/history', label: 'Delivery history', icon: 'clock', primary: true },
  { to: '/partner/earnings', label: 'Earnings & payouts', icon: 'wallet', primary: true },
  { to: '/partner/onboarding', label: 'Profile & documents', icon: 'user', primary: true },
];

export const shell: RoleShellConfig = {
  Context: PartnerProfileCard,
  MobileContext: PartnerMobileContext,
  Footer: PartnerStatusFooter,
  userSubtitle: 'Delivery partner',
};

export const routes: RouteObject[] = [
  {
    // Layout route: owns the location watch so it survives navigation inside /partner.
    ...page(() => import('./PartnerLayout')),
    children: [
      { index: true, ...page(() => import('./PartnerHome')) },
      { path: 'onboarding', ...page(() => import('./PartnerOnboarding')) },
      { path: 'history', ...page(() => import('./HistoryPage')) },
      { path: 'earnings', ...page(() => import('./EarningsPage')) },
      { path: '*', element: <NotFoundPage home="/partner" /> },
    ],
  },
];
