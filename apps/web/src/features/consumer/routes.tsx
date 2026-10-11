/**
 * Consumer area routes. The area mounts its own chrome (`chrome = 'none'`) as layout routes:
 *   discover   ConsumerLayout variant="discover"   /, /search, /offers
 *   restaurant ConsumerLayout variant="restaurant" /restaurants/:idOrSlug (breadcrumb + Cart · N)
 *   account    ConsumerLayout variant="account"    /orders*, /account*, /membership, /support*, /notifications, /cart
 *   checkout   CheckoutShell                       /checkout, /checkout/status/:id, /demo-pay/:intentId
 * Guests can browse, build a cart and see offers; private pages wrap themselves in <RequireAuth>. Pages are
 * code-split with React.lazy + a page-level Suspense skeleton.
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router';
import { CheckoutShell } from '../../components/layout/CheckoutShell';
import { NotFoundPage } from '../../components/layout/ErrorBoundary';
import { CONSUMER_TAB_NAV } from '../../components/layout/ConsumerShell';
import type { NavItem } from '../../components/layout/RoleNav';
import { SkeletonList } from '../../components/ui/Skeleton';
import { ConsumerLayout } from './ConsumerLayout';

function page(Component: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-busy="true" className="mx-auto w-full max-w-[1200px] px-6 pt-7">
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
const OffersPage = lazy(() => import('./OffersPage'));
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

export const chrome = 'none';
export const nav: NavItem[] = CONSUMER_TAB_NAV;

export const routes: RouteObject[] = [
  {
    element: <ConsumerLayout variant="discover" />,
    children: [
      { index: true, element: page(HomePage) },
      { path: 'search', element: page(SearchPage) },
      { path: 'offers', element: page(OffersPage) },
    ],
  },
  {
    element: <ConsumerLayout variant="restaurant" />,
    children: [{ path: 'restaurants/:idOrSlug', element: page(RestaurantPage) }],
  },
  {
    element: <CheckoutShell />,
    children: [
      { path: 'checkout', element: page(CheckoutPage) },
      { path: 'checkout/status/:checkoutId', element: page(CheckoutStatusPage) },
    ],
  },
  {
    element: <CheckoutShell title="Payment" />,
    children: [{ path: 'demo-pay/:intentId', element: page(DemoPayPage) }],
  },
  {
    element: <ConsumerLayout variant="account" />,
    children: [
      { path: 'cart', element: page(CartPage) },
      { path: 'orders', element: page(OrdersPage) },
      { path: 'orders/:checkoutId', element: page(OrderDetailPage) },
      { path: 'account', element: page(ProfilePage) },
      { path: 'account/addresses', element: page(AddressesPage) },
      { path: 'membership', element: page(MembershipPage) },
      { path: 'support', element: page(SupportPage) },
      { path: 'support/:ticketId', element: page(TicketPage) },
      { path: 'notifications', element: page(NotificationsPage) },
      { path: '*', element: <NotFoundPage home="/" /> },
    ],
  },
];
