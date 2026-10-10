/**
 * Partner area layout (route element for every /partner/* page). It owns the ONE location watch so sharing keeps
 * running while an online partner browses history, earnings or onboarding, and stops when they go offline or leave
 * the partner area. Pages read the state with `usePartnerTracking()`.
 */
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { profileQueryOptions } from './api';
import { useLocationTracking, type LocationTracking } from './useLocationTracking';

const OFF: LocationTracking = { status: 'off', lastSentAt: null, sendError: null, pausedReason: null };
const TrackingContext = createContext<LocationTracking>(OFF);

export function usePartnerTracking(): LocationTracking {
  return useContext(TrackingContext);
}

const LABEL: Record<string, string> = {
  active: 'Location sharing active',
  paused: 'Location sharing paused',
  starting: 'Location sharing starting…',
  denied: 'Location sharing blocked',
  unsupported: 'Location sharing unavailable',
};

export default function PartnerLayout() {
  const profile = useQuery(profileQueryOptions());
  const { pathname } = useLocation();
  const online = profile.data?.status === 'APPROVED' && profile.data.online;
  const tracking = useLocationTracking({ enabled: Boolean(online) });
  const onHome = pathname.replace(/\/+$/, '') === '/partner';

  return (
    <TrackingContext.Provider value={tracking}>
      {online && !onHome && LABEL[tracking.status] ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-control bg-surface-muted px-3 py-2 text-sm" role="status" aria-live="polite" data-testid="tracking-strip">
          <Badge tone={tracking.status === 'active' ? 'success' : tracking.status === 'starting' ? 'info' : 'warn'} dot>
            {LABEL[tracking.status]}
          </Badge>
          <span className="text-slate-600">
            {tracking.lastSentAt ? <>Last sent <RelativeTime value={tracking.lastSentAt} staleAfterSec={30} /></> : 'Nothing sent yet'}
          </span>
        </div>
      ) : null}
      <Outlet />
    </TrackingContext.Provider>
  );
}
