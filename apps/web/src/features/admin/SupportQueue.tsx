/** `/admin/support`: ticket queue by status (open / in-progress counts from ORD-2 `support`). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Badge } from '../../components/ui/Badge';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { listTickets, qk, type Ticket } from './api';
import { useOrdersOverview } from './shell';
import { FilterPills } from './ui';

const STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
];

export default function SupportQueue() {
  const [params, setParams] = useSearchParams();
  const status = STATUSES.some((s) => s.value === params.get('status')) ? params.get('status')! : 'OPEN';
  const pages = useCursorPages();
  const overview = useOrdersOverview();
  const query = useQuery({
    queryKey: qk.tickets({ status, cursor: pages.cursor }),
    queryFn: () => listTickets({ status: status === 'ALL' ? undefined : status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const counts: Record<string, number | undefined> = { OPEN: overview.data?.support.open, IN_PROGRESS: overview.data?.support.inProgress };

  const columns: Column<Ticket>[] = [
    { key: 'subject', header: 'Ticket', cell: (t) => <span><span className="font-mono text-[12.5px] text-fg-3">{t.code}</span> {t.subject}</span>, primary: true },
    { key: 'category', header: 'Category', cell: (t) => humanize(t.category), secondary: true },
    { key: 'status', header: 'Status', cell: (t) => <StatusPill kind="ticket" status={t.status} density="dense" /> },
    {
      key: 'priority',
      header: 'Priority',
      cell: (t) => (t.priority ? <Badge tone={t.priority === 'HIGH' || t.priority === 'URGENT' ? 'bad' : t.priority === 'MEDIUM' ? 'warn' : 'neu'} density="dense">{humanize(t.priority)}</Badge> : <span className="text-fg-3">—</span>),
      hideOnMobile: true,
    },
    { key: 'assignee', header: 'Assigned', cell: (t) => (t.assigneeId ? 'Assigned' : <span className="text-fg-3">Unassigned</span>), hideOnMobile: true },
    { key: 'messages', header: 'Messages', cell: (t) => <span className="font-mono">{t.messages?.length ?? 0}</span>, align: 'right', hideOnMobile: true },
    { key: 'created', header: 'Age', cell: (t) => <RelativeTime value={t.createdAt} className="text-fg-3" />, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Support" description="Customer tickets about orders, payments and deliveries." />
      <div className="flex flex-col gap-3.5">
        <FilterPills
          label="Ticket status"
          value={status}
          onChange={(v) => {
            pages.reset();
            setParams({ status: v }, { replace: true });
          }}
          options={STATUSES.map((s) => ({ ...s, count: counts[s.value] ?? null }))}
        />
        <DataTable
          caption="Support tickets"
          columns={columns}
          rows={query.data?.items}
          getRowId={(t) => t.id}
          loading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => query.refetch()}
          rowHref={(t) => `/admin/support/${t.id}`}
          empty={{ icon: 'ticket', title: status === 'OPEN' ? 'No open tickets' : 'No tickets in this status', description: 'New tickets from customers appear here.' }}
          footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
        />
      </div>
    </>
  );
}
