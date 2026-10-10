/**
 * Online card (board 30, rows 30-09 / 30-10). Going online first asks for geolocation and sends the real fix to
 * `POST /partner/online`; denied permission blocks going online with an explanation. While online the layout's
 * tracking hook posts `POST /partner/location` every ~5 s and this card shows "last sent Ns ago" (or why sharing is
 * paused). Going offline with a delivery in hand answers 409 PARTNER_HAS_ACTIVE_JOBS: the switch stays on with
 * "Complete it, or ask Thali ops to reassign it".
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { InlineError } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Toggle } from '../../components/ui/Toggle';
import { useGeolocation } from '../../hooks/useGeolocation';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/errors';
import { goOffline, goOnline, partnerKeys, type PartnerProfile } from './api';
import type { LocationTracking } from './useLocationTracking';

export interface OnlineToggleProps {
  partner: PartnerProfile;
  tracking: LocationTracking;
  activeCount: number;
  className?: string;
}

/** Partner-specific copy: unlike customers, partners cannot "drop a pin" instead of sharing location. */
const GEO_COPY: Record<string, string> = {
  denied: 'Location is blocked for this site. Allow location in your browser settings, then try again.',
  unavailable: "Your device can't find a location right now. Turn on location services (GPS) and try again.",
  timeout: 'Finding your location took too long. Move to an open area, check GPS, and try again.',
  unsupported: "This browser can't share your location, so it can't be used for deliveries. Try Chrome or Safari over HTTPS.",
};

const PAUSE_COPY: Record<string, string> = {
  hidden: 'Your browser pauses location while this tab is in the background or the screen is locked.',
  unavailable: "Your device can't find a location right now. Check that location services are on.",
  timeout: 'Your device is taking too long to find a location.',
};

function OnlineSub({ tracking }: { tracking: LocationTracking }) {
  const s = tracking.status;
  if (s === 'active' || s === 'starting') {
    return (
      <>
        <span aria-hidden="true" className="size-[7px] shrink-0 animate-pulse-ok rounded-full bg-ok" />
        <span>
          {s === 'starting' ? 'Starting location sharing…' : 'Location sharing active'}
          {tracking.lastSentAt ? (
            <>
              {' · '}
              <RelativeTime value={tracking.lastSentAt} prefix="last sent" staleAfterSec={30} />
            </>
          ) : s === 'active' ? ' · sending your first update' : null}
        </span>
      </>
    );
  }
  const text = s === 'paused' ? 'Location paused — keep Thali open' : s === 'denied' ? 'Location blocked — allow it in your browser settings' : 'This browser can’t share your location';
  return (
    <>
      <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-warn" />
      <span className="font-medium text-warn">
        {text}
        {tracking.lastSentAt ? (
          <span className="font-normal text-fg-3">
            {' · '}
            <RelativeTime value={tracking.lastSentAt} prefix="last sent" staleAfterSec={30} />
          </span>
        ) : null}
      </span>
    </>
  );
}

export function OnlineToggle({ partner, tracking, activeCount, className }: OnlineToggleProps) {
  const qc = useQueryClient();
  const geo = useGeolocation({ highAccuracy: true, timeoutMs: 15_000, maximumAgeMs: 0 });
  const [blocked, setBlocked] = useState(false);
  const titleId = useId();

  const setProfile = (p: PartnerProfile) => qc.setQueryData(partnerKeys.profile, p);

  const online = useMutation({
    mutationFn: async () => {
      setBlocked(false);
      const fix = await geo.request();
      if (!fix) return null;
      return goOnline({ lat: fix.lat, lng: fix.lng });
    },
    onSuccess: (p) => {
      if (p) setProfile(p);
      else setBlocked(true);
    },
  });
  const offline = useMutation({
    mutationFn: goOffline,
    onSuccess: setProfile,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PARTNER_HAS_ACTIVE_JOBS') {
        void qc.invalidateQueries({ queryKey: partnerKeys.active });
        void qc.invalidateQueries({ queryKey: partnerKeys.profile });
      }
    },
  });
  const hasActiveError = offline.error instanceof ApiError && offline.error.code === 'PARTNER_HAS_ACTIVE_JOBS';
  // Once the active deliveries are done, clear a stale 409 so the message disappears.
  const resetOffline = offline.reset;
  useEffect(() => {
    if (activeCount === 0) resetOffline();
  }, [activeCount, resetOffline]);

  const busy = online.isPending || offline.isPending;
  const geoProblem = blocked ? (GEO_COPY[geo.status] ?? GEO_COPY.unavailable) : null;
  const isOnline = partner.online;

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex flex-wrap items-center gap-4 rounded-card border border-line bg-card px-5 py-[18px] max-sm:px-4 max-sm:py-3.5', className)}
    >
      <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
        <h1 id={titleId} className="font-sans text-[26px] font-semibold leading-tight tracking-[-0.035em] max-sm:text-2xl">
          {isOnline ? 'You’re online' : 'You’re offline'}
        </h1>
        <p className="flex items-center gap-2 text-[13.5px] text-fg-3" aria-live="polite" data-testid="tracking-status">
          {isOnline ? <OnlineSub tracking={tracking} /> : 'Go online to receive offers. We’ll ask for location permission.'}
        </p>
      </div>
      <Toggle
        size="lg"
        label="Online"
        checked={isOnline}
        pending={busy}
        onChange={(next) => (next ? online.mutate() : offline.mutate())}
      />

      {isOnline && tracking.status === 'paused' && tracking.pausedReason ? (
        <p className="basis-full text-[13px] text-fg-2">{PAUSE_COPY[tracking.pausedReason]}</p>
      ) : null}
      {isOnline && tracking.status === 'denied' ? (
        <p className="basis-full text-[13px] text-bad">Customers can’t see you move and offers may stop until you allow location for this site.</p>
      ) : null}
      {isOnline && tracking.status === 'unsupported' ? <p className="basis-full text-[13px] text-bad">{GEO_COPY.unsupported}</p> : null}
      {isOnline && tracking.sendError ? (
        <p className="basis-full text-[13px] text-warn">Last update didn’t reach Thali: {tracking.sendError} Retrying with your next position.</p>
      ) : null}

      {geoProblem ? (
        <div role="alert" className="basis-full rounded-control bg-bad-bg px-3.5 py-3 text-[13.5px] text-fg-2">
          <p className="font-semibold text-bad">You can’t go online without sharing your location.</p>
          <p className="mt-1">Offers are matched by how close you are to the restaurant. {geoProblem}</p>
        </div>
      ) : null}
      {hasActiveError ? (
        <div role="alert" className="basis-full rounded-control bg-warn-bg px-3.5 py-3 text-[13.5px] text-fg-2">
          <p className="font-semibold text-warn">You have an active delivery.</p>
          <p className="mt-1">Complete it, or ask Thali ops to reassign it, before going offline.</p>
        </div>
      ) : null}
      <InlineError error={online.error ?? (hasActiveError ? null : offline.error)} className="basis-full" />
    </section>
  );
}
