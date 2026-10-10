/**
 * Real device location sharing for an online partner. NEVER simulates movement: only fixes delivered by
 * `navigator.geolocation.watchPosition` are sent.
 *
 *   const tracking = useLocationTracking({ enabled: partner.online });
 *   tracking.status      'off' | 'starting' | 'active' | 'paused' | 'denied' | 'unsupported'
 *   tracking.lastSentAt  epoch ms of the last successful POST (null until one succeeds)
 *
 * - Each fix is posted to `POST /partner/location`, throttled to one send per `throttleMs` (5 s). The server applies it to
 *   every active job of the partner, so no job-scoped call is made (it would share the same rate limiter).
 * - `paused` = tab hidden / screen locked (browsers suspend geolocation) or the device cannot produce a fix right now.
 *   When the tab becomes visible again the watch is restarted (some browsers silently drop it in the background).
 * - The watch is cleared when `enabled` turns false and on unmount.
 */
import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { postPartnerLocation } from './api';

export const LOCATION_THROTTLE_MS = 5_000;

export type TrackingStatus = 'off' | 'starting' | 'active' | 'paused' | 'denied' | 'unsupported';

export interface UseLocationTrackingOptions {
  enabled: boolean;
  throttleMs?: number;
}

export interface LocationTracking {
  status: TrackingStatus;
  /** Epoch ms of the last successful send. */
  lastSentAt: number | null;
  /** Why the last send failed (cleared on the next success). */
  sendError: string | null;
  /** Why we are paused, when we know ('hidden' | 'unavailable' | 'timeout'). */
  pausedReason: 'hidden' | 'unavailable' | 'timeout' | null;
}

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const hasGeo = () => typeof navigator !== 'undefined' && 'geolocation' in navigator && navigator.geolocation != null;

export function useLocationTracking({ enabled, throttleMs = LOCATION_THROTTLE_MS }: UseLocationTrackingOptions): LocationTracking {
  const [gotFix, setGotFix] = useState(false);
  const [denied, setDenied] = useState(false);
  const [geoError, setGeoError] = useState<'unavailable' | 'timeout' | null>(null);
  const [hidden, setHidden] = useState(isHidden);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  // Page visibility: pause the indicator when hidden, restart the watch when visible again.
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      const h = isHidden();
      setHidden(h);
      if (!h) setEpoch((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !hasGeo()) return;
    let stopped = false;
    let lastAttempt = -Infinity;
    setDenied(false);

    const send = async (lat: number, lng: number, accuracyM: number) => {
      const body = { lat, lng, accuracyM };
      try {
        await postPartnerLocation(body);
        if (stopped) return;
        setLastSentAt(Date.now());
        setSendError(null);
      } catch (err) {
        if (!stopped) setSendError(errorMessage(err));
      }
    };

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (stopped) return;
        setGotFix(true);
        setGeoError(null);
        setDenied(false);
        const now = Date.now();
        if (now - lastAttempt < throttleMs) return;
        lastAttempt = now;
        void send(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      (err) => {
        if (stopped) return;
        if (err.code === 1) setDenied(true);
        else setGeoError(err.code === 3 ? 'timeout' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );

    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(id);
    };
  }, [enabled, throttleMs, epoch]);

  // Reset derived state when going offline.
  useEffect(() => {
    if (!enabled) {
      setGotFix(false);
      setGeoError(null);
      setDenied(false);
      setSendError(null);
    }
  }, [enabled]);

  let status: TrackingStatus;
  if (!enabled) status = 'off';
  else if (!hasGeo()) status = 'unsupported';
  else if (denied) status = 'denied';
  else if (hidden || geoError) status = 'paused';
  else if (gotFix) status = 'active';
  else status = 'starting';

  return {
    status,
    lastSentAt: enabled ? lastSentAt : null,
    sendError: enabled ? sendError : null,
    pausedReason: enabled ? (hidden ? 'hidden' : geoError) : null,
  };
}
