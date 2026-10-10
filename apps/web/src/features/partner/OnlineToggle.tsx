/**
 * Go online / offline. Going online first asks for geolocation permission and sends the real fix to
 * `POST /partner/online`; denied permission blocks going online with an explanation. While online the
 * tracking hook (owned by PartnerHome) streams locations; this component shows its state and last send time.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Switch } from '../../components/ui/Checkbox';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { useToast } from '../../components/ui/Toast';
import { useGeolocation, GEO_MESSAGES } from '../../hooks/useGeolocation';
import { goOffline, goOnline, partnerKeys, type PartnerProfile } from './api';
import type { LocationTracking } from './useLocationTracking';

export interface OnlineToggleProps {
  partner: PartnerProfile;
  tracking: LocationTracking;
  activeCount: number;
}

const PAUSE_COPY: Record<string, string> = {
  hidden: 'The tab is in the background or the screen is locked, so your browser has paused location.',
  unavailable: "Your device can't find a location right now. Check that location services are on.",
  timeout: 'Your device is taking too long to find a location.',
};

export function OnlineToggle({ partner, tracking, activeCount }: OnlineToggleProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const geo = useGeolocation({ highAccuracy: true, timeoutMs: 15_000, maximumAgeMs: 0 });
  const [blocked, setBlocked] = useState<string | null>(null);
  const [confirmOffline, setConfirmOffline] = useState(false);

  const setProfile = (p: PartnerProfile) => qc.setQueryData(partnerKeys.profile, p);

  const online = useMutation({
    mutationFn: async () => {
      setBlocked(null);
      const fix = await geo.request();
      if (!fix) return null;
      return goOnline({ lat: fix.lat, lng: fix.lng });
    },
    onSuccess: (p) => {
      if (p) {
        setProfile(p);
        toast({ title: "You're online", description: 'Offers will start appearing here.', tone: 'success' });
      } else {
        setBlocked('geo');
      }
    },
  });
  const offline = useMutation({
    mutationFn: goOffline,
    onSuccess: (p) => {
      setProfile(p);
      toast({ title: "You're offline", description: 'Location sharing has stopped.', tone: 'info' });
    },
  });

  const busy = online.isPending || offline.isPending;
  const geoProblem = blocked === 'geo' ? (geo.message ?? GEO_MESSAGES.unavailable) : null;
  const trackingLabel =
    tracking.status === 'active' ? 'Location sharing active'
    : tracking.status === 'paused' ? 'Location sharing paused'
    : tracking.status === 'starting' ? 'Location sharing starting…'
    : tracking.status === 'denied' ? 'Location sharing blocked'
    : tracking.status === 'unsupported' ? 'Location sharing unavailable'
    : null;

  return (
    <Card aria-labelledby="online-heading">
      <h2 id="online-heading" className="sr-only">
        Availability
      </h2>
      <div className="flex items-center justify-between gap-3">
        <Switch
          label={partner.online ? 'You are online' : 'You are offline'}
          description={partner.online ? 'Switch off to stop receiving offers.' : 'Switch on to receive delivery offers. We will ask to use your location.'}
          checked={partner.online}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) online.mutate();
            else if (activeCount > 0) setConfirmOffline(true);
            else offline.mutate();
          }}
          className="grow"
        />
        <Badge tone={partner.online ? 'success' : 'neutral'} dot>
          {partner.online ? 'Online' : 'Offline'}
        </Badge>
      </div>

      {geoProblem ? (
        <div role="alert" className="mt-3 rounded-control border border-danger-100 bg-danger-50 p-3 text-sm text-danger-800">
          <p className="font-semibold">You can't go online without sharing your location.</p>
          <p className="mt-1">
            Offers are matched by how close you are to the restaurant. {geoProblem}
          </p>
        </div>
      ) : null}
      <InlineError error={online.error ?? offline.error} className="mt-3" />

      {partner.online && trackingLabel ? (
        <div className="mt-3 text-sm" aria-live="polite" data-testid="tracking-status">
          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
            <Badge tone={tracking.status === 'active' ? 'success' : tracking.status === 'starting' ? 'info' : 'warn'} dot>
              {trackingLabel}
            </Badge>
            {tracking.lastSentAt ? (
              <span className="font-normal text-slate-600">
                Last sent <RelativeTime value={tracking.lastSentAt} staleAfterSec={30} />
              </span>
            ) : (
              <span className="font-normal text-slate-600">Nothing sent yet</span>
            )}
          </p>
          {tracking.status === 'paused' && tracking.pausedReason ? <p className="mt-1 text-slate-700">{PAUSE_COPY[tracking.pausedReason]}</p> : null}
          {tracking.status === 'denied' ? (
            <p className="mt-1 text-danger-700">Location is blocked for this site. Allow it in your browser settings, otherwise customers cannot see you and offers may stop.</p>
          ) : null}
          {tracking.status === 'unsupported' ? <p className="mt-1 text-danger-700">{GEO_MESSAGES.unsupported}</p> : null}
          {tracking.sendError ? <p className="mt-1 text-warn-800">Last update did not reach Thali: {tracking.sendError} Retrying with your next position.</p> : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOffline}
        onClose={() => setConfirmOffline(false)}
        title="Go offline during a delivery?"
        description="You have an active delivery. Going offline stops location sharing, so the customer can no longer follow you. You can still complete the delivery."
        confirmLabel="Go offline"
        tone="danger"
        onConfirm={async () => {
          await offline.mutateAsync();
        }}
      />
    </Card>
  );
}
