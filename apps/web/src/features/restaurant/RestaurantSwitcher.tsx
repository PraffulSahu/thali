/**
 * Restaurant switcher (design-spec 20-02): the KITCHEN sidebar context card (initials tile, name, locality,
 * up-down chevrons) opening a menu of every restaurant the owner has (`GET /owner/restaurants`) with a status
 * chip, plus "+ Add restaurant". Choosing one stores the selection (selection.ts); every page remounts on it.
 * The phone top bar gets a compact name button that opens the same list in a bottom sheet.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Icon, Sheet, Skeleton, StatusPill, initials } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { useRestaurants, type OwnerRestaurant } from './api';
import { Popover } from './kit';
import { useNewOrderCounts } from './orderStream';
import { resolveSelected, setSelectedRestaurantId, useSelectedRestaurantId } from './selection';

/** "Indiranagar" (MKT-5 locality), else the city. */
export function restaurantArea(r: Pick<OwnerRestaurant, 'address'>): string {
  return r.address?.locality?.trim() || r.address?.city?.trim() || '';
}

function Tile({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid size-[30px] shrink-0 place-items-center rounded-badge bg-acc-soft text-xs font-semibold text-acc-fg', className)}>
      {initials(name) || '·'}
    </span>
  );
}

function RestaurantList({ list, currentId, onPick, counts }: { list: OwnerRestaurant[]; currentId: string | undefined; onPick: () => void; counts: Map<string, number> }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="lbl px-2 pb-1 pt-1">Your restaurants</p>
      <ul className="flex flex-col gap-0.5">
        {list.map((r) => {
          const current = r.id === currentId;
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  setSelectedRestaurantId(r.id);
                  onPick();
                }}
                className={cn(
                  'flex min-h-12 w-full items-start gap-2.5 rounded-item px-2 py-1.5 text-left hover:bg-fill [@media(pointer:coarse)]:min-h-touch',
                  current && 'bg-fill',
                )}
              >
                <Tile name={r.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-fg">{r.name}</span>
                    {current ? <Icon name="check" size={14} className="shrink-0 text-acc-fg" label="Selected" /> : null}
                  </span>
                  <span className="truncate text-xs text-fg-3">{restaurantArea(r) || 'No address yet'}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill kind="restaurant" status={r.status} density="dense" />
                    {counts.get(r.id) ? (
                      <span className="rounded-pill bg-acc px-[7px] py-0.5 font-mono text-[11px] text-pri-fg">
                        {counts.get(r.id)} new
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 border-t border-line pt-1">
        <Link
          to="/restaurant/onboarding"
          onClick={onPick}
          className="flex min-h-10 items-center gap-2.5 rounded-item px-2 text-sm font-medium text-fg-2 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:min-h-touch"
        >
          <Icon name="plus" size={16} /> Add restaurant
        </Link>
      </div>
    </div>
  );
}

function useCurrent() {
  const auth = useAuth();
  const list = useRestaurants(auth.hasRole('RESTAURANT_OWNER'));
  const current = resolveSelected(list.data, useSelectedRestaurantId());
  const counts = useNewOrderCounts(Boolean(list.data?.some((r) => r.status === 'APPROVED')));
  /** new orders waiting at restaurants other than the selected one */
  const elsewhere = [...counts].reduce((n, [id, c]) => (id === current?.id ? n : n + c), 0);
  return { list, current, counts, elsewhere };
}

/** Sidebar context slot. */
export function RestaurantSwitcher() {
  const { list, current, counts, elsewhere } = useCurrent();
  if (list.isPending) return <Skeleton className="h-[52px] w-full rounded-control" />;
  if (!list.data?.length || !current) {
    return (
      <Link
        to="/restaurant/onboarding"
        className="flex h-[52px] w-full items-center gap-2.5 rounded-control border border-dashed border-line-2 bg-card px-2.5 text-sm font-medium text-fg-2 hover:text-fg"
      >
        <Icon name="plus" size={16} /> Add restaurant
      </Link>
    );
  }
  const area = restaurantArea(current);
  return (
    <Popover
      label="Switch restaurant"
      align="start"
      role="dialog"
      panelClassName="right-0 p-2"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          aria-label={`Switch restaurant. Current: ${current.name}${area ? `, ${area}` : ''}${elsewhere ? `. ${elsewhere} new at your other restaurants` : ''}`}
          className="flex h-[52px] w-full items-center gap-2.5 rounded-control border border-line bg-card px-2.5 text-left hover:border-line-2"
        >
          <span className="relative">
            <Tile name={current.name} />
            {elsewhere ? <span aria-hidden="true" className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-card bg-acc" /> : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{current.name}</span>
            {area ? <span className="block truncate text-xs text-fg-3">{area}</span> : null}
          </span>
          <Icon name="chevrons-up-down" size={14} className="shrink-0 text-fg-3" />
        </button>
      )}
    >
      {(close) => <RestaurantList list={list.data!} currentId={current.id} onPick={close} counts={counts} />}
    </Popover>
  );
}

/** ≤640 top-bar context: restaurant name with a chevron, opening the list as a bottom sheet. */
export function RestaurantSwitcherMobile() {
  const { list, current, counts, elsewhere } = useCurrent();
  const [open, setOpen] = useState(false);
  if (!current || !list.data) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Switch restaurant. Current: ${current.name}${elsewhere ? `. ${elsewhere} new at your other restaurants` : ''}`}
        aria-haspopup="dialog"
        className="flex min-h-touch max-w-full items-center gap-1 truncate text-sm font-medium text-fg"
      >
        <span className="truncate">{current.name}</span>
        {elsewhere ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-acc" /> : null}
        <Icon name="chevron-down" size={16} className="shrink-0 text-fg-3" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Switch restaurant" side="bottom">
        <RestaurantList list={list.data} currentId={current.id} onPick={() => setOpen(false)} counts={counts} />
      </Sheet>
    </>
  );
}
