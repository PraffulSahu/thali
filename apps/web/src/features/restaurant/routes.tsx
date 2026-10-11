/**
 * Restaurant area routes. Chrome = the KITCHEN RoleSidebarShell (auto chrome reads `nav` + `shell`): restaurant
 * switcher context card with locality, nav with the live-order badge, owner block at the bottom.
 * `onboarding*` only needs sign-in (the guard is applied by RoleArea); every other page lives inside
 * RestaurantLayout, which loads the owner's restaurants, shows the status banner and provides the selection.
 */
import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';
import { NavCount } from '../../components/layout/RoleNav';
import type { RoleShellConfig } from '../../components/layout/RoleSidebarShell';
import { useQuery } from '@tanstack/react-query';
import { keys, ordersApi, useRestaurants } from './api';
import RestaurantLayout from './RestaurantLayout';
import { RestaurantSwitcher, RestaurantSwitcherMobile } from './RestaurantSwitcher';
import { resolveSelected, useSelectedRestaurantId } from './selection';

const page = (load: () => Promise<{ default: ComponentType }>) => ({ lazy: () => load().then((m) => ({ Component: m.default })) });

/**
 * Count of orders waiting for accept/reject (20-04, hidden at 0). Shares the board's query key, so the live
 * board's realtime refetches update it too; elsewhere it polls every 30 s (RestaurantLayout also streams).
 */
export function NewOrdersBadge() {
  const list = useRestaurants();
  const selected = resolveSelected(list.data, useSelectedRestaurantId());
  const id = selected?.status === 'APPROVED' ? selected.id : undefined;
  const q = useQuery({
    queryKey: keys.orders(id ?? ''),
    queryFn: () => ordersApi.active(id!),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
  const count = q.data?.items.filter((o) => o.status === 'PLACED').length;
  return <NavCount count={count} label="new orders" />;
}

export const nav: NavItem[] = [
  { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true, primary: true },
  { to: '/restaurant/orders', label: 'Live orders', icon: 'receipt', end: true, Badge: NewOrdersBadge, primary: true },
  { to: '/restaurant/orders/history', label: 'Order history', icon: 'clock' },
  { to: '/restaurant/menu', label: 'Menu', icon: 'list', primary: true },
  { to: '/restaurant/settings', label: 'Store settings', icon: 'settings' },
  { to: '/restaurant/finance', label: 'Finance', icon: 'wallet', primary: true },
];

export const shell: RoleShellConfig = {
  Context: RestaurantSwitcher,
  MobileContext: RestaurantSwitcherMobile,
  userSubtitle: 'Owner',
};

export const routes: RouteObject[] = [
  { path: 'onboarding', ...page(() => import('./OnboardingWizard')) },
  { path: 'onboarding/:restaurantId', ...page(() => import('./OnboardingWizard')) },
  {
    element: <RestaurantLayout />,
    children: [
      { index: true, ...page(() => import('./DashboardPage')) },
      { path: 'orders', ...page(() => import('./OrdersBoard')) },
      { path: 'orders/history', ...page(() => import('./OrderHistoryPage')) },
      { path: 'menu', ...page(() => import('./MenuPage')) },
      { path: 'settings', ...page(() => import('./StoreSettingsPage')) },
      { path: 'finance', ...page(() => import('./FinancePage')) },
    ],
  },
  { path: '*', element: <NotFoundPage home="/restaurant" /> },
];
