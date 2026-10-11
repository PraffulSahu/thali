/**
 * Wraps every post-onboarding page (inside the KITCHEN RoleSidebarShell): loads the owner's restaurants, applies
 * the switcher selection (sidebar context card, RestaurantSwitcher), keeps the status banner on top of main and
 * keeps new-order chimes running for all of the owner's restaurants (the live board chimes for its own).
 */
import { Outlet, useLocation } from 'react-router';
import { ButtonLink, QueryState, Skeleton } from '../../components/ui';
import { RestaurantContext } from './RestaurantContext';
import { useRestaurants } from './api';
import { useAllNewOrders } from './orderStream';
import { resolveSelected, useSelectedRestaurantId } from './selection';
import { StatusBanner } from './StatusBanner';

/** New-order chime + announcement for every restaurant of the owner (the live board handles its own restaurant). */
function BackgroundAlerts({ skipRestaurantId }: { skipRestaurantId?: string }) {
  const { announcement } = useAllNewOrders({ skipRestaurantId });
  return (
    <div role="status" aria-live="assertive" className="sr-only">
      {announcement}
    </div>
  );
}

function LayoutSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-hidden="true">
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}

export default function RestaurantLayout() {
  const list = useRestaurants();
  const selectedId = useSelectedRestaurantId();
  const { pathname } = useLocation();
  const onBoard = /\/restaurant\/orders\/?$/.test(pathname);

  return (
    <QueryState
      query={list}
      loading={<LayoutSkeleton />}
      loadingLabel="Loading your restaurants…"
      isEmpty={(d) => d.length === 0}
      empty={{
        icon: 'store',
        title: 'Register your restaurant',
        description: 'Add your restaurant or cloud kitchen to start taking orders on Thali.',
        action: <ButtonLink to="/restaurant/onboarding">Start onboarding</ButtonLink>,
      }}
    >
      {(restaurants) => {
        const current = resolveSelected(restaurants, selectedId)!;
        return (
          <RestaurantContext.Provider value={{ restaurant: current }}>
            <StatusBanner restaurant={current} className="mb-5" />
            {restaurants.some((r) => r.status === 'APPROVED') ? (
              <BackgroundAlerts skipRestaurantId={onBoard && current.status === 'APPROVED' ? current.id : undefined} />
            ) : null}
            {/* remount pages when the selection changes so no state leaks between restaurants */}
            <Outlet key={current.id} />
          </RestaurantContext.Provider>
        );
      }}
    </QueryState>
  );
}
