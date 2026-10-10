/**
 * TanStack Query client with defaults that match the API:
 *  - queries retry up to 2x only for retryable failures (network, 408, 429, 5xx); never 4xx
 *  - staleTime 15 s, refetch on window focus / reconnect
 *  - mutations never auto-retry (use idempotency keys and let the user retry explicitly)
 *
 * Query key conventions (so areas can invalidate each other's data):
 *   ['me'], ['cart'], ['orders', ...], ['order', checkoutId], ['owner', 'orders', restaurantId, ...],
 *   ['partner', ...], ['admin', <section>, ...], ['meta']
 */
import { QueryClient } from '@tanstack/react-query';
import { isRetryable } from './errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => failureCount < 2 && isRetryable(error),
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}
