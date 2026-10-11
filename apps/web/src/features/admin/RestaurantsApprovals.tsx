/** `/admin/restaurants`: restaurants by status (default: awaiting approval) with live counts, searchable by name. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDate } from '../../lib/format';
import { listRestaurants, qk, type AdminRestaurant } from './api';
import { useMarketplaceOverview } from './shell';
import { DemoTag, FilterPills } from './ui';

const STATUS_OPTIONS = [
  { value: 'APPROVAL_PENDING', label: 'Awaiting approval' },
  { value: 'VERIFICATION_PENDING', label: 'Email pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ALL', label: 'All' },
];

export default function RestaurantsApprovals() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'APPROVAL_PENDING';
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const pages = useCursorPages();
  const overview = useMarketplaceOverview();
  const counts = overview.data?.restaurants.byStatus;

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
    {
      key: 'name',
      header: 'Restaurant',
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          {r.name}
          {r.isDemo ? <DemoTag /> : null}
        </span>
      ),
      primary: true,
    },
    { key: 'area', header: 'Area', cell: (r) => (r.address ? [r.address.city, r.address.pincode].filter(Boolean).join(' · ') : '—'), secondary: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill kind="restaurant" status={r.status} density="dense" /> },
    {
      key: 'email',
      header: 'Business email',
      cell: (r) => (r.emailVerified ? <Badge tone="ok" density="dense" dot>Verified</Badge> : <Badge tone="warn" density="dense" dot>Not verified</Badge>),
    },
    { key: 'docs', header: 'Documents', cell: (r) => <span className="font-mono text-[12.5px]">{`${r.documents.filter((d) => d.verified).length}/${r.documents.length} verified`}</span>, hideOnMobile: true },
    { key: 'created', header: 'Submitted', cell: (r) => <span className="text-fg-3">{formatDate(r.createdAt)}</span>, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Restaurants" description="Review applications, documents and live restaurants." />
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterPills
            label="Restaurant status"
            value={status}
            onChange={(v) => update({ status: v })}
            options={STATUS_OPTIONS.map((o) => ({ ...o, count: o.value === 'ALL' ? overview.data?.restaurants.total : counts ? counts[o.value] ?? 0 : null }))}
          />
          <form
            role="search"
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update({ q: draft.trim() });
            }}
          >
            <Input type="search" icon="search" aria-label="Search restaurants by name" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Restaurant name" className="w-56" />
            <Button type="submit" variant="outline" size="sm">
              Search
            </Button>
          </form>
        </div>
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
            title: status === 'APPROVAL_PENDING' && !q ? 'No restaurants are waiting for approval' : 'No restaurants match these filters',
            description: 'Try another status or clear the search.',
            action: (
              <Button
                variant="outline"
                onClick={() => {
                  setDraft('');
                  update({ status: 'ALL', q: '' });
                }}
              >
                Show all restaurants
              </Button>
            ),
          }}
          footer={
            <Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />
          }
        />
      </div>
    </>
  );
}
