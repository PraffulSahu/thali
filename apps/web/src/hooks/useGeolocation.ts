/**
 * One-shot browser geolocation with explicit permission states.
 *
 *   const geo = useGeolocation();
 *   <Button onClick={geo.request} loading={geo.status === 'locating'}>Use my location</Button>
 *   if (geo.status === 'denied') -> explain + offer the map pin
 *   if (geo.position) -> geo.position.lat / lng / accuracyM
 *
 * status:
 *   'idle'        nothing requested yet (permission may be 'granted' already; see `permission`)
 *   'locating'    waiting for a fix
 *   'success'     `position` is set
 *   'denied'      user/browser blocked location (PERMISSION_DENIED)
 *   'unavailable' no fix possible (POSITION_UNAVAILABLE, e.g. GPS off)
 *   'timeout'     no fix within `timeoutMs`
 *   'unsupported' no navigator.geolocation (or insecure http origin)
 * `permission` mirrors the Permissions API ('granted' | 'denied' | 'prompt' | 'unknown') and updates live.
 * For continuous tracking (partner app) use navigator.geolocation.watchPosition directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '@thali/contracts';

export type GeolocationStatus = 'idle' | 'locating' | 'success' | 'denied' | 'unavailable' | 'timeout' | 'unsupported';
export type GeoPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface GeoFix extends GeoPoint {
  accuracyM: number;
  at: number;
}

export interface UseGeolocationOptions {
  timeoutMs?: number;
  maximumAgeMs?: number;
  highAccuracy?: boolean;
}

export const GEO_MESSAGES: Record<Exclude<GeolocationStatus, 'idle' | 'locating' | 'success'>, string> = {
  denied: 'Location access is blocked. Allow it in your browser settings, or drop a pin on the map instead.',
  unavailable: "We couldn't get your location. Check that location services are on, or drop a pin on the map.",
  timeout: 'Finding your location took too long. Try again, or drop a pin on the map.',
  unsupported: "This browser can't share your location. Drop a pin on the map instead.",
};

export function useGeolocation(opts: UseGeolocationOptions = {}) {
  const { timeoutMs = 10_000, maximumAgeMs = 60_000, highAccuracy = true } = opts;
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator && navigator.geolocation != null;
  const [status, setStatus] = useState<GeolocationStatus>(supported ? 'idle' : 'unsupported');
  const [position, setPosition] = useState<GeoFix | null>(null);
  const [permission, setPermission] = useState<GeoPermission>('unknown');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let perm: PermissionStatus | null = null;
    const update = () => perm && mounted.current && setPermission(perm.state as GeoPermission);
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((p) => {
          perm = p;
          update();
          p.addEventListener('change', update);
        })
        .catch(() => undefined);
    }
    return () => {
      mounted.current = false;
      perm?.removeEventListener('change', update);
    };
  }, []);

  const request = useCallback((): Promise<GeoFix | null> => {
    if (!supported) {
      setStatus('unsupported');
      return Promise.resolve(null);
    }
    setStatus('locating');
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const fix: GeoFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, at: pos.timestamp };
          if (mounted.current) {
            setPosition(fix);
            setStatus('success');
            setPermission('granted');
          }
          resolve(fix);
        },
        (err) => {
          const next: GeolocationStatus = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
          if (mounted.current) {
            setStatus(next);
            if (next === 'denied') setPermission('denied');
          }
          resolve(null);
        },
        { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maximumAgeMs },
      );
    });
  }, [supported, highAccuracy, timeoutMs, maximumAgeMs]);

  const message = status === 'idle' || status === 'locating' || status === 'success' ? null : GEO_MESSAGES[status];
  return { status, position, permission, request, message, supported };
}
