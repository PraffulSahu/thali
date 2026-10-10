/** `/admin/restaurants`: restaurants by status (default: awaiting approval), searchable by name. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';
import { Badge } from '../../components/ui/Badge';
import { formatDate } from '../../lib/format';
import { listRestaurants, qk, type AdminRestaurant } from './api';
import { FilterBar } from './shared';

const STATUS_OPTIONS = [
  { value: 'APPROVAL_PENDING', label: 'Awaiting approval' },
  { value: 'VERIFICATION_PENDING', label: 'Email verification pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ALL', label: 'All statuses' },
];

export default function RestaurantsApprovals() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'APPROVAL_PENDING';
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const pages = useCursorPages();

  const query = useQuery({
    queryKey: qk.restaurants({ status, q, cursor: pages.cursor }),
    queryFn: () => listRestaurants({ status: status === 'ALL' ? undefined : status, q: q || undefined, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });

  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    pages.reset();
    setParams(p, { replace: true });
  };

  const columns: Column<AdminRestaurant>[] = [
    { key: 'name', header: 'Restaurant', cell: (r) => r.name, primary: true },
    { key: 'city', header: 'City', cell: (r) => r.address?.city ?? '-', secondary: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill kind="restaurant" status={r.status} /> },
    {
      key: 'email',
      header: 'Business email',
      cell: (r) => (r.emailVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warn">Not verified</Badge>),
    },
    { key: 'docs', header: 'Documents', cell: (r) => `${r.documents.filter((d) => d.verified).length}/${r.documents.length} verified`, hideOnMobile: true },
    { key: 'created', header: 'Created', cell: (r) => formatDate(r.createdAt), hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Restaurants" description="Review applications, documents and live restaurants." />
      <FilterBar onSubmit={() => update({ q: draft.trim() })}>
        <Field label="Status">
          <Select value={status} onChange={(e) => update({ status: e.target.value })} options={STATUS_OPTIONS} />
        </Field>
        <Field label="Search by name" className="sm:col-span-1 lg:col-span-2">
          <Input type="search" icon="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Restaurant name" />
        </Field>
        <Button type="submit" variant="secondary">Search</Button>
      </FilterBar>
      <DataTable
        caption="Restaurants"
        columns={columns}
        rows={query.data?.items}
        getRowId={(r) => r.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        rowHref={(r) => `/admin/restaurants/${r.id}`}
        empty={{
          icon: 'store',
          title: status === 'APPROVAL_PENDING' ? 'No restaurants are waiting for approval' : 'No restaurants match these filters',
          description: 'Try another status or clear the search.',
          action: <Button variant="secondary" onClick={() => { setDraft(''); update({ status: 'ALL', q: '' }); }}>Show all restaurants</Button>,
        }}
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
