/** `/admin/partners`: delivery partners by status (default: awaiting approval) with live counts. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { formatDate, formatPhone } from '../../lib/format';
import { listPartners, qk, type AdminPartner } from './api';
import { useTmsOverview } from './shell';
import { DemoTag, FilterPills } from './ui';

const STATUS_OPTIONS = [
  { value: 'APPROVAL_PENDING', label: 'Awaiting approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ALL', label: 'All' },
];

export default function PartnersApprovals() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'APPROVAL_PENDING';
  const pages = useCursorPages();
  const overview = useTmsOverview();
  const counts = overview.data?.partners.byStatus;
  const query = useQuery({
    queryKey: qk.partners({ status, cursor: pages.cursor }),
    queryFn: () => listPartners({ status: status === 'ALL' ? undefined : status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<AdminPartner>[] = [
    {
      key: 'name',
      header: 'Partner',
      cell: (p) => (
        <span className="inline-flex items-center gap-2">
          {p.name}
          {p.isDemo ? <DemoTag /> : null}
        </span>
      ),
      primary: true,
    },
    { key: 'phone', header: 'Phone', cell: (p) => <span className="font-mono text-[12.5px]">{formatPhone(p.phone) || '—'}</span>, secondary: true },
    { key: 'vehicle', header: 'Vehicle', cell: (p) => (p.vehicle ? <span>{humanize(p.vehicle.type)} <span className="font-mono text-[12px] text-fg-3">{p.vehicle.registrationNumber}</span></span> : '—') },
    { key: 'status', header: 'Status', cell: (p) => <StatusPill kind="partner" status={p.status} density="dense" /> },
    { key: 'docs', header: 'Documents', cell: (p) => <span className="font-mono text-[12.5px]">{p.documents.length}</span>, align: 'right', hideOnMobile: true },
    {
      key: 'online',
      header: 'Availability',
      cell: (p) => (p.online ? <Badge tone="ok" density="dense" dot>Online · {p.activeJobIds.length}/{p.maxActive}</Badge> : <Badge density="dense">Offline</Badge>),
      hideOnMobile: true,
    },
    { key: 'created', header: 'Joined', cell: (p) => <span className="text-fg-3">{formatDate(p.createdAt)}</span>, hideOnMobile: true },
  ];

  const total = counts ? Object.values(counts).reduce((n, c) => n + c, 0) : null;
  return (
    <>
      <PageHeader title="Delivery partners" description="Review applications and manage the delivery fleet." />
      <div className="flex flex-col gap-3.5">
        <FilterPills
          label="Partner status"
          value={status}
          onChange={(v) => {
            const p = new URLSearchParams(params);
            p.set('status', v);
            pages.reset();
            setParams(p, { replace: true });
          }}
          options={STATUS_OPTIONS.map((o) => ({ ...o, count: o.value === 'ALL' ? total : counts ? counts[o.value] ?? 0 : null }))}
        />
        <DataTable
          caption="Delivery partners"
          columns={columns}
          rows={query.data?.items}
          getRowId={(p) => p.id}
          loading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => query.refetch()}
          rowHref={(p) => `/admin/partners/${p.id}`}
          empty={{ icon: 'bike', title: status === 'APPROVAL_PENDING' ? 'No partners are waiting for approval' : 'No partners match this status' }}
          footer={
            <Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />
          }
        />
      </div>
    </>
  );
}
