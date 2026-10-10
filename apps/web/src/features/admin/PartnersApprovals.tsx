/** `/admin/partners`: delivery partners by status (default: awaiting approval). */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDate, formatPhone } from '../../lib/format';
import { listPartners, qk, type AdminPartner } from './api';
import { FilterBar } from './shared';

const STATUS_OPTIONS = [
  { value: 'APPROVAL_PENDING', label: 'Awaiting approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ALL', label: 'All statuses' },
];

export default function PartnersApprovals() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'APPROVAL_PENDING';
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: qk.partners({ status, cursor: pages.cursor }),
    queryFn: () => listPartners({ status: status === 'ALL' ? undefined : status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<AdminPartner>[] = [
    { key: 'name', header: 'Partner', cell: (p) => p.name, primary: true },
    { key: 'phone', header: 'Phone', cell: (p) => formatPhone(p.phone) || '-', secondary: true },
    { key: 'vehicle', header: 'Vehicle', cell: (p) => (p.vehicle ? `${p.vehicle.type} ${p.vehicle.registrationNumber}` : '-') },
    { key: 'status', header: 'Status', cell: (p) => <StatusPill kind="partner" status={p.status} /> },
    { key: 'online', header: 'Availability', cell: (p) => (p.online ? <Badge tone="success">Online</Badge> : <Badge>Offline</Badge>), hideOnMobile: true },
    { key: 'created', header: 'Joined', cell: (p) => formatDate(p.createdAt), hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Delivery partners" description="Review applications and manage the delivery fleet." />
      <FilterBar>
        <Field label="Status">
          <Select
            value={status}
            onChange={(e) => {
              const p = new URLSearchParams(params);
              p.set('status', e.target.value);
              pages.reset();
              setParams(p, { replace: true });
            }}
            options={STATUS_OPTIONS}
          />
        </Field>
      </FilterBar>
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
          <Pagination
            hasPrev={pages.hasPrev}
            hasNext={Boolean(query.data?.nextCursor)}
            onPrev={pages.prev}
            onNext={() => pages.next(query.data!.nextCursor!)}
            page={pages.page}
            loading={query.isFetching}
          />
        }
      />
    </>
  );
}
