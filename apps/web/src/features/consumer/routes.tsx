/**
 * Consumer area routes (Task 17). Guests can browse, build a cart and pay only after OTP sign-in; private pages
 * wrap themselves in <RequireAuth>. Pages are code-split with React.lazy + Suspense because area routes are
 * descendant routes rendered by `useRoutes` (route-object `lazy` is a data-router-only feature).
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import type { NavItem } from '../../components/layout/RoleNav';
import { SkeletonList } from '../../components/ui/Skeleton';
import { ConsumerHeaderActions } from './HeaderActions';

function page(Component: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <SkeletonList count={3} />
        </div>
      }
    >
      <Component />
    </Suspense>
  );
}

const HomePage = lazy(() => import('./HomePage'));
const SearchPage = lazy(() => import('./SearchPage'));
const RestaurantPage = lazy(() => import('./RestaurantPage'));
const CartPage = lazy(() => import('./CartPage'));
const CheckoutPage = lazy(() => import('./CheckoutPage'));
const CheckoutStatusPage = lazy(() => import('./CheckoutStatusPage'));
const DemoPayPage = lazy(() => import('./DemoPayPage'));
const OrdersPage = lazy(() => import('./OrdersPage'));
const OrderDetailPage = lazy(() => import('./OrderDetailPage'));
const ProfilePage = lazy(() => import('./ProfilePage'));
const AddressesPage = lazy(() => import('./AddressesPage'));
const MembershipPage = lazy(() => import('./MembershipPage'));
const SupportPage = lazy(() => import('./SupportPage'));
const TicketPage = lazy(() => import('./SupportPage').then((m) => ({ default: m.TicketPage })));
const NotificationsPage = lazy(() => import('./NotificationsPage'));

export const nav: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/cart', label: 'Cart', icon: 'cart' },
  { to: '/orders', label: 'Orders', icon: 'receipt' },
  { to: '/account', label: 'Account', icon: 'user' },
];

export const HeaderActions = ConsumerHeaderActions;

export const routes: RouteObject[] = [
  { index: true, element: page(HomePage) },
  { path: 'search', element: page(SearchPage) },
  { path: 'restaurants/:idOrSlug', element: page(RestaurantPage) },
  { path: 'cart', element: page(CartPage) },
  { path: 'checkout', element: page(CheckoutPage) },
  { path: 'checkout/status/:checkoutId', element: page(CheckoutStatusPage) },
  { path: 'demo-pay/:intentId', element: page(DemoPayPage) },
  { path: 'orders', element: page(OrdersPage) },
  { path: 'orders/:checkoutId', element: page(OrderDetailPage) },
  { path: 'account', element: page(ProfilePage) },
  { path: 'account/addresses', element: page(AddressesPage) },
  { path: 'membership', element: page(MembershipPage) },
  { path: 'support', element: page(SupportPage) },
  { path: 'support/:ticketId', element: page(TicketPage) },
  { path: 'notifications', element: page(NotificationsPage) },
  { path: '*', element: <NotFoundPage home="/" /> },
];
