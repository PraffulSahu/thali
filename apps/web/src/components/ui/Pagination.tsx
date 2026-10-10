/**
 * Cursor pagination (LLD §1.3: `?limit&cursor` -> `{ items, nextCursor }`).
 *
 * Page-by-page (tables):
 *   const pages = useCursorPages();
 *   const q = useQuery({ queryKey: ['orders', pages.cursor], queryFn: () => api<Paginated<Order>>('/orders', { query: { cursor: pages.cursor, limit: 20 } }), placeholderData: keepPreviousData });
 *   <Pagination hasPrev={pages.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pages.prev}
 *     onNext={() => pages.next(q.data!.nextCursor!)} page={pages.page} loading={q.isFetching} />
 *   // reset when filters change: pages.reset()
 *
 * Infinite list: use TanStack `useInfiniteQuery` with `getNextPageParam: (p) => p.nextCursor ?? undefined`
 * and <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />.
 */
import { useCallback, useState } from 'react';
import { Button } from './Button';

export function useCursorPages() {
  const [stack, setStack] = useState<string[]>([]);
  const next = useCallback((cursor: string) => setStack((s) => [...s, cursor]), []);
  const prev = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const reset = useCallback(() => setStack([]), []);
  return {
    /** Cursor for the current page (undefined = first page). */
    cursor: stack[stack.length - 1] as string | undefined,
    page: stack.length + 1,
    hasPrev: stack.length > 0,
    next,
    prev,
    reset,
  };
}

export interface PaginationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  page?: number;
  loading?: boolean;
  className?: string;
}

export function Pagination({ hasPrev, hasNext, onPrev, onNext, page, loading, className }: PaginationProps) {
  if (!hasPrev && !hasNext) return null;
  return (
    <nav aria-label="Pagination" className={`flex items-center justify-between gap-3 pt-4 ${className ?? ''}`}>
      <Button variant="secondary" size="sm" icon="chevron-left" onClick={onPrev} disabled={!hasPrev || loading}>
        Previous
      </Button>
      {page ? (
        <span className="text-[13px] text-fg-3" aria-live="polite">
          Page {page}
        </span>
      ) : null}
      <Button variant="secondary" size="sm" iconRight="chevron-right" onClick={onNext} disabled={!hasNext || loading}>
        Next
      </Button>
    </nav>
  );
}

export function LoadMore({ hasMore, loading, onClick, label = 'Load more' }: { hasMore: boolean | undefined; loading?: boolean; onClick: () => void; label?: string }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center pt-4">
      <Button variant="secondary" onClick={onClick} loading={loading}>
        {label}
      </Button>
    </div>
  );
}
