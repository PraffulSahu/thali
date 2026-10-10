/**
 * Gateway runtime metadata (`GET /api/v1/meta`, public):
 *   { mode: 'demo'|'sandbox'|'production', brand, currency, timezone,
 *     providers: { payment, sms, email, maps, storage: 'live'|'sandbox'|'demo' } }
 *
 *   const { meta, isDemo, mode } = useMeta();
 *   {isDemo && <Badge tone="info">Demo estimate</Badge>}
 *
 * Cached for the session (staleTime Infinity). While loading/failed, `mode` is undefined: render nothing
 * mode-specific rather than guessing.
 */
import { useQuery } from '@tanstack/react-query';
import type { AppMode } from '@thali/contracts';
import { api } from '../lib/api';

export type ProviderMode = 'live' | 'sandbox' | 'demo';

export interface AppMeta {
  mode: AppMode;
  brand?: string;
  currency?: string;
  timezone?: string;
  providers?: Partial<Record<'payment' | 'sms' | 'email' | 'maps' | 'storage', ProviderMode>>;
}

export const META_QUERY_KEY = ['meta'] as const;

export function useMeta() {
  const q = useQuery({
    queryKey: META_QUERY_KEY,
    queryFn: () => api<AppMeta>('/meta', { auth: false }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });
  const mode = q.data?.mode;
  return {
    meta: q.data,
    mode,
    isDemo: mode === 'demo',
    isSandbox: mode === 'sandbox',
    isProduction: mode === 'production',
    isLoading: q.isPending,
    error: q.error,
  };
}
