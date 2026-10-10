/**
 * Partner area layout (route element for every /partner/* page). It owns the ONE location watch so sharing keeps
 * running while an online partner browses history, earnings or onboarding, and stops when they go offline or leave
 * the partner area. Pages read the state with `usePartnerTracking()`. Off the home page a slim strip keeps the
 * sharing state visible ("Location sharing active · last sent 4s ago").
 */
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { cn } from '../../lib/cn';
import { profileQueryOptions } from './api';
import { useLocationTracking, type LocationTracking, type TrackingStatus } from './useLocationTracking';

const OFF: LocationTracking = { status: 'off', lastSentAt: null, sendError: null, pausedReason: null };
const TrackingContext = createContext<LocationTracking>(OFF);

export function usePartnerTracking(): LocationTracking {
  return useContext(TrackingContext);
}

export const TRACKING_LABEL: Partial<Record<TrackingStatus, string>> = {
  active: 'Location sharing active',
  paused: 'Location paused — keep Thali open',
  starting: 'Starting location sharing…',
  denied: 'Location blocked in your browser',
  unsupported: 'This browser can’t share location',
};

export default function PartnerLayout() {
  const profile = useQuery(profileQueryOptions());
  const { pathname } = useLocation();
  const online = profile.data?.status === 'APPROVED' && profile.data.online;
  const tracking = useLocationTracking({ enabled: Boolean(online) });
  const onHome = pathname.replace(/\/+$/, '') === '/partner';
  const label = TRACKING_LABEL[tracking.status];
  const ok = tracking.status === 'active';

  return (
    <TrackingContext.Provider value={tracking}>
      {online && !onHome && label ? (
        <div
          className={cn(
            'mb-[18px] flex flex-wrap items-center gap-x-2 gap-y-1 rounded-field border border-line px-4 py-2.5 text-[13px]',
            ok ? 'bg-card text-fg-2' : 'bg-warn-bg text-warn',
          )}
          role="status"
          aria-live="polite"
          data-testid="tracking-strip"
        >
          <span aria-hidden="true" className={cn('size-[7px] rounded-full', ok ? 'animate-pulse-ok bg-ok' : 'bg-warn')} />
          <span className="font-medium">You’re online · {label}</span>
          <span className={ok ? 'text-fg-3' : ''}>
            {tracking.lastSentAt ? <RelativeTime value={tracking.lastSentAt} prefix="· last sent" staleAfterSec={30} /> : '· nothing sent yet'}
          </span>
          <Link to="/partner" className="ml-auto font-semibold text-fg underline underline-offset-2">
            Back to home
          </Link>
        </div>
      ) : null}
      <Outlet />
    </TrackingContext.Provider>
  );
}
