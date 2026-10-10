/**
 * Delivery history `/partner/history` (design-spec §7.4): `GET /deliveries/history` (cursor pages, newest first),
 * "Load more". Finished jobs show the drop AREA + label only — no customer address is retained (DLV-2 ruling).
 * Row: result chip · restaurant → drop area · date (IST) + order code · distance (mono).
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { ButtonLink } from '../../components/ui/Button';
import { LoadMore } from '../../components/ui/Pagination';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime, formatDistanceKm } from '../../lib/format';
import { listHistory, type PartnerJob } from './api';
import { dropTitle } from './format';

function HistoryRow({ job }: { job: PartnerJob }) {
  const when = job.deliveredAt ?? job.pickedUpAt ?? job.assignedAt ?? job.createdAt;
  const ref = job.childOrderCode ?? job.checkoutCode;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0 sm:px-5" data-testid="history-row">
      <StatusPill kind="delivery" status={job.status} className="shrink-0" />
      <div className="min-w-[200px] flex-1">
        <p className="text-[14.5px] font-medium text-fg">
          {job.pickup.name} <span className="text-fg-3">→</span> {dropTitle(job.drop.area ?? 'Area not shared', job.drop.label)}
        </p>
        <p className="text-[13px] text-fg-3">
          <span className="tabular-nums">{formatDateTime(when)}</span>
          {ref ? <span className="font-mono"> · {ref}</span> : null}
        </p>
        {job.failureReason ? <p className="text-[13px] text-bad">Reason: {job.failureReason}</p> : null}
      </div>
      <span className="font-mono text-[13px] text-fg-2">{formatDistanceKm(job.distanceKm)}</span>
    </li>
  );
}

function HistorySkeleton() {
  return (
    <div className="overflow-hidden rounded-field border border-line bg-card">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-0">
          <Skeleton className="h-6 w-20 rounded-pill" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

export default function HistoryPage() {
  const q = useInfiniteQuery({
    queryKey: ['partner', 'history'],
    queryFn: ({ pageParam }) => listHistory(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items);
  const query = { ...q, data: items, refetch: q.refetch };

  return (
    <>
      <PageHeader title="Delivery history" description="Your finished deliveries, newest first. Times in IST." />
      <QueryState
        query={query}
        loading={<HistorySkeleton />}
        isEmpty={(d) => d.length === 0}
        empty={{
          icon: 'clock',
          title: 'No deliveries yet',
          description: 'Finished and failed deliveries are listed here.',
          action: <ButtonLink to="/partner" variant="outline">Go to home</ButtonLink>,
        }}
      >
        {(rows) => (
          <section aria-label="Delivery history" className="overflow-hidden rounded-field border border-line bg-card">
            <header className="flex items-center justify-between border-b border-line px-4 py-3.5 sm:px-5">
              <h2 className="text-[14.5px]">Deliveries</h2>
              <span className="font-mono text-[11px] font-medium text-fg-3">{rows.length}{q.hasNextPage ? '+' : ''}</span>
            </header>
            <ul>
              {rows.map((j) => (
                <HistoryRow key={j.id} job={j} />
              ))}
            </ul>
            <div className="border-t border-line px-4 pb-4 empty:hidden">
              <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
            </div>
          </section>
        )}
      </QueryState>
    </>
  );
}
