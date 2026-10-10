/**
 * Wraps every post-onboarding page: loads the owner's restaurants, applies the switcher selection, shows the
 * status banner and keeps new-order alerts running on pages other than the orders board.
 */
import { Outlet, useLocation } from 'react-router';
import { ButtonLink, Field, QueryState, Select, StatusPill } from '../../components/ui';
import { RestaurantContext } from './RestaurantContext';
import { useRestaurants } from './api';
import { useOrderStream } from './orderStream';
import { resolveSelected, setSelectedRestaurantId, useSelectedRestaurantId } from './selection';
import { StatusBanner } from './StatusBanner';

function BackgroundAlerts({ restaurantId }: { restaurantId: string }) {
  useOrderStream(restaurantId);
  return null;
}

export default function RestaurantLayout() {
  const list = useRestaurants();
  const selectedId = useSelectedRestaurantId();
  const { pathname } = useLocation();
  const onBoard = /\/restaurant\/orders\/?$/.test(pathname);

  return (
    <QueryState
      query={list}
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
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              {restaurants.length > 1 ? (
                <Field label="Restaurant" className="min-w-56">
                  <Select
                    value={current.id}
                    onChange={(e) => setSelectedRestaurantId(e.target.value)}
                    options={restaurants.map((r) => ({ value: r.id, label: r.name }))}
                  />
                </Field>
              ) : (
                <p className="flex items-center gap-2 text-sm text-slate-600">
                  <span className="font-medium text-slate-900">{current.name}</span>
                  <StatusPill kind="restaurant" status={current.status} />
                </p>
              )}
              <ButtonLink to="/restaurant/onboarding" variant="ghost" size="sm" icon="plus">
                Add another restaurant
              </ButtonLink>
            </div>
            <StatusBanner restaurant={current} />
            {current.status === 'APPROVED' && !onBoard ? <BackgroundAlerts key={current.id} restaurantId={current.id} /> : null}
            {/* remount pages when the selection changes so no state leaks between restaurants */}
            <Outlet key={current.id} />
          </RestaurantContext.Provider>
        );
      }}
    </QueryState>
  );
}
