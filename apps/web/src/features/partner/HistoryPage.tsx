/** Completed and failed deliveries (`GET /deliveries/history`, cursor pagination). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime, formatDistanceKm } from '../../lib/format';
import { listHistory, partnerKeys, type PartnerJob } from './api';

const columns: Column<PartnerJob>[] = [
  { key: 'order', header: 'Order', cell: (j) => <span className="tabular-nums">{j.childOrderId}</span>, primary: true },
  { key: 'status', header: 'Result', cell: (j) => <StatusPill kind="delivery" status={j.status} />, secondary: true },
  { key: 'route', header: 'Pickup to drop', cell: (j) => `${j.pickup.name} to ${j.drop.address}` },
  { key: 'distance', header: 'Distance', cell: (j) => <span className="tabular-nums">{formatDistanceKm(j.distanceKm)}</span>, align: 'right' },
  {
    key: 'when',
    header: 'Finished',
    cell: (j) => (
      <span className="tabular-nums">
        {formatDateTime(j.deliveredAt ?? j.createdAt)}
        {j.failureReason ? <span className="block text-xs text-danger-700">Reason: {j.failureReason}</span> : null}
      </span>
    ),
  },
];

export default function HistoryPage() {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: partnerKeys.history(pages.cursor), queryFn: () => listHistory(pages.cursor), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader title="Delivery history" description="Your completed and failed deliveries." />
      <DataTable
        caption="Delivery history"
        columns={columns}
        rows={q.data?.items}
        getRowId={(j) => j.id}
        loading={q.isPending}
        error={q.isError ? q.error : undefined}
        onRetry={q.refetch}
        empty={{ icon: 'clock', title: 'No deliveries yet', description: 'Finished deliveries will be listed here.' }}
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => q.data?.nextCursor && pages.next(q.data.nextCursor)} page={pages.page} loading={q.isFetching} />}
      />
    </>
  );
}
