/**
 * Render a TanStack Query result with every state handled:
 *   pending        -> `loading` (default: skeleton list) inside role="status"
 *   401            -> <SessionExpiredState> (sign in again, route preserved)
 *   403            -> <ForbiddenState>
 *   other error    -> <ErrorState> with "Try again" (refetch) and the request reference
 *   isEmpty(data)  -> <EmptyState {...empty}>
 *   data           -> children(data)
 * If a background refetch fails while data is shown, the data stays and a small "couldn't refresh" bar
 * with Retry appears above it.
 *
 *   const q = useQuery({ queryKey: ['orders'], queryFn: () => api<Paginated<Order>>('/orders') });
 *   <QueryState query={q} isEmpty={(d) => d.items.length === 0}
 *     empty={{ icon: 'receipt', title: 'No orders yet', description: 'Your orders will appear here.', action: <ButtonLink to="/discover">Browse restaurants</ButtonLink> }}
 *     loading={<SkeletonList count={3} />}>
 *     {(data) => <OrderList orders={data.items} />}
 *   </QueryState>
 */
import type { ReactNode } from 'react';
import { errorMessage, isForbidden, isUnauthenticated } from '../../lib/errors';
import { Button } from './Button';
import { EmptyState, type EmptyStateProps } from './EmptyState';
import { ErrorState, ForbiddenState, SessionExpiredState, type ForbiddenStateProps } from './ErrorState';
import { Icon } from './Icon';
import { SkeletonList } from './Skeleton';

/** The subset of UseQueryResult that QueryState reads (so tests can pass plain objects). */
export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
}

export interface QueryStateProps<T> {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  loadingLabel?: string;
  isEmpty?: (data: T) => boolean;
  empty?: EmptyStateProps;
  errorTitle?: ReactNode;
  forbidden?: ForbiddenStateProps;
  signInPath?: string;
}

export function QueryState<T>({
  query, children, loading, loadingLabel = 'Loading…', isEmpty, empty, errorTitle, forbidden, signInPath,
}: QueryStateProps<T>) {
  const { data, isPending, isError, error } = query;

  if (data === undefined) {
    if (isError) {
      if (isUnauthenticated(error)) return <SessionExpiredState signInPath={signInPath} />;
      if (isForbidden(error)) return <ForbiddenState {...forbidden} />;
      return <ErrorState error={error} title={errorTitle} onRetry={() => query.refetch()} retrying={query.isFetching} />;
    }
    if (isPending) {
      return (
        <div role="status" aria-busy="true">
          <span className="sr-only">{loadingLabel}</span>
          {loading ?? <SkeletonList count={3} />}
        </div>
      );
    }
    return null;
  }

  if (isEmpty?.(data)) return <EmptyState title="Nothing here yet" {...empty} />;

  return (
    <>
      {isError ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-field border border-line bg-warn-bg px-3.5 py-2.5 text-[13px] text-fg-2">
          <Icon name="alert" size={16} className="text-warn" />
          <span className="flex-1">Couldn&rsquo;t refresh: {errorMessage(error)} Showing the last loaded data.</span>
          <Button variant="link" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {children(data)}
    </>
  );
}
