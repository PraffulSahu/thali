/**
 * Restaurant area routes (Task 18). `onboarding*` only needs sign-in (the guard is applied by RoleArea); every
 * other page lives inside RestaurantLayout, which loads the owner's restaurants, shows the status banner and
 * provides the selected restaurant.
 */
import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';
import { NavCount } from '../../components/layout/RoleNav';
import { useQuery } from '@tanstack/react-query';
import { keys, ordersApi, useRestaurants } from './api';
import RestaurantLayout from './RestaurantLayout';
import { resolveSelected, useSelectedRestaurantId } from './selection';

const page = (load: () => Promise<{ default: ComponentType }>) => ({ lazy: () => load().then((m) => ({ Component: m.default })) });

/** Count of orders waiting for accept/reject, shown next to "Orders" in the nav. */
function NewOrdersBadge() {
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
  { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
  { to: '/restaurant/orders', label: 'Orders', icon: 'receipt', Badge: NewOrdersBadge },
  { to: '/restaurant/menu', label: 'Menu', icon: 'list' },
  { to: '/restaurant/settings', label: 'Store settings', icon: 'settings' },
  { to: '/restaurant/finance', label: 'Finance', icon: 'wallet' },
];

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
