/** `/admin/support`: ticket queue by status. UNVERIFIED API shape (orders admin-support routes not written yet). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Select } from '../../components/ui/Select';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { listTickets, qk, type Ticket } from './api';

const STATUSES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
];

export default function SupportQueue() {
  const [status, setStatus] = useState('OPEN');
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: qk.tickets({ status, cursor: pages.cursor }),
    queryFn: () => listTickets({ status: status === 'ALL' ? undefined : status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Ticket>[] = [
    { key: 'subject', header: 'Ticket', cell: (t) => `${t.code}: ${t.subject}`, primary: true },
    { key: 'category', header: 'Category', cell: (t) => humanize(t.category), secondary: true },
    { key: 'status', header: 'Status', cell: (t) => <StatusPill kind="ticket" status={t.status} /> },
    { key: 'assignee', header: 'Assigned', cell: (t) => (t.assigneeId ? 'Assigned' : 'Unassigned'), hideOnMobile: true },
    { key: 'messages', header: 'Messages', cell: (t) => t.messages?.length ?? 0, align: 'right', hideOnMobile: true },
    { key: 'created', header: 'Opened', cell: (t) => <RelativeTime value={t.createdAt} />, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Support" description="Customer tickets about orders, payments and deliveries." />
      <div className="mb-4 w-full sm:w-56">
        <Field label="Status">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); pages.reset(); }} options={STATUSES} />
        </Field>
      </div>
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
    </>
  );
}
