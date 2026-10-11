/**
 * `/admin/tms`: delivery operations (design-spec §7.5). KPI strip from DLV-5 overview; segmented tabs Unassigned ·
 * Offered · Exceptions · By status (`?filter=` in the URL, `/admin/tms?filter=unassigned` from the overview tile);
 * code search (DLV-4 `q`); Assign / Reassign (DLV-7 nearest-partner picker), Unassign, Mark failed, and the demo-only
 * location simulator (labelled DEMO). Reads: any admin; changes: OPS (others see why).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Input } from '../../components/ui/Input';
import { KpiStrip, KpiTile } from '../../components/ui/KpiTile';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { Select } from '../../components/ui/Select';
import { StatusPill, statusLabel } from '../../components/ui/StatusPill';
import { EstBadge } from '../../components/ui/EstBadge';
import { useMeta } from '../../hooks/useMeta';
import { formatDistanceKm, formatMinutes, plural } from '../../lib/format';
import { failJob, listJobs, listPartners, qk, simulateJob, unassignJob, type AdminJob } from './api';
import { PartnerPicker, jobLabel } from './PartnerPicker';
import { Mono, useAdminMutation, useAdminRoles } from './shared';
import { unassignedCount, useTmsOverview } from './shell';
import { agoLabel, ageLabel, DemoTag, RoleNote, useNow } from './ui';

const POLL_MS = 15_000;
const STATUSES = ['PENDING_ASSIGNMENT', 'OFFERED', 'ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED', 'DELIVERED', 'CANCELLED'];
const SIMULATABLE = new Set(['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY']);
type Filter = 'unassigned' | 'offered' | 'exceptions' | 'status';
const FILTERS: Filter[] = ['unassigned', 'offered', 'exceptions', 'status'];

export default function TmsPage() {
  const { canOps } = useAdminRoles();
  const { isDemo } = useMeta();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const filter: Filter = FILTERS.includes(params.get('filter') as Filter) ? (params.get('filter') as Filter) : 'unassigned';
  const status = params.get('status') && STATUSES.includes(params.get('status')!) ? params.get('status')! : 'ASSIGNED';
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const [picking, setPicking] = useState<AdminJob | null>(null);
  const [unassigning, setUnassigning] = useState<AdminJob | null>(null);
  const [failing, setFailing] = useState<AdminJob | null>(null);
  const pages = useCursorPages();

  const setParam = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    pages.reset();
    setParams(p, { replace: true });
  };

  const overview = useTmsOverview(POLL_MS);
  const jobsParams =
    filter === 'exceptions' ? { exception: true } : filter === 'unassigned' ? { status: 'PENDING_ASSIGNMENT' } : filter === 'offered' ? { status: 'OFFERED' } : { status };
  const jobs = useQuery({
    queryKey: qk.jobs({ ...jobsParams, q, cursor: pages.cursor }),
    queryFn: () => listJobs({ ...jobsParams, q: q || undefined, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
  });
  const names = useQuery({ queryKey: qk.partners({ status: 'APPROVED', names: true }), queryFn: () => listPartners({ status: 'APPROVED', limit: 100 }), staleTime: 60_000 });
  const partnerName = (id: string | null) => (id ? names.data?.items.find((p) => p.id === id)?.name ?? `Partner …${id.slice(-4)}` : null);

  const unassign = useAdminMutation((v: { id: string; reason?: string }) => unassignJob(v.id, v.reason), { success: 'Delivery unassigned and re-dispatching', invalidate: [['admin', 'tms']] });
  const fail = useAdminMutation((v: { id: string; reason: string }) => failJob(v.id, v.reason), { success: 'Delivery marked failed', invalidate: [['admin', 'tms']] });
  const simulate = useAdminMutation((id: string) => simulateJob(id), { success: (d) => `Demo simulation started: ${d.steps} location updates`, invalidate: [['admin', 'tms']] });

  const ov = overview.data;
  const inProgress = ov ? ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'].reduce((n, s) => n + (ov.jobsByStatus[s] ?? 0), 0) : 0;
  const unassigned = unassignedCount(ov) ?? 0;
  const kpi = { loading: overview.isPending, unavailable: overview.isError, onRetry: () => void overview.refetch() };

  const columns: Column<AdminJob>[] = [
    { key: 'order', header: 'Order', cell: (j) => <span className="font-mono">{jobLabel(j)}</span>, primary: true },
    { key: 'pickup', header: 'Pickup', cell: (j) => j.pickup.name, secondary: true },
    { key: 'drop', header: 'Drop', cell: (j) => [j.drop.area, j.drop.label].filter(Boolean).join(' · ') || <span className="whitespace-normal">{j.drop.address}</span>, hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (j) => <StatusPill kind="delivery" status={j.status} density="dense" /> },
    {
      key: 'attention',
      header: 'Attention',
      cell: (j) =>
        j.exception ? (
          <span className="whitespace-normal text-[12.5px] text-bad">{j.exceptionReason ?? 'Needs a decision'}</span>
        ) : j.failureReason ? (
          <span className="whitespace-normal text-[12.5px] text-bad">{j.failureReason}</span>
        ) : (
          <span className="text-fg-3">—</span>
        ),
    },
    { key: 'partner', header: 'Partner', cell: (j) => partnerName(j.partnerId) ?? <span className="text-fg-3">Unassigned</span> },
    { key: 'rounds', header: 'Rounds', cell: (j) => <span className="font-mono">{j.dispatchRound}</span>, align: 'right', hideOnMobile: true },
    {
      key: 'trip',
      header: 'Trip',
      cell: (j) => (
        <span className="inline-flex items-center gap-1.5">
          {formatDistanceKm(j.distanceKm)} · {formatMinutes(j.estimatedMinutes)}
          {j.estimateSource !== 'GOOGLE' ? <EstBadge /> : null}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'age', header: 'Age', cell: (j) => <span className="text-fg-3">{ageLabel(j.createdAt, now)}</span>, hideOnMobile: true },
  ];

  const filterLabel = filter === 'status' ? statusLabel('delivery', status).toLowerCase() : filter;

  return (
    <>
      <PageHeader
        title="Deliveries"
        meta={
          <span aria-live="off">
            {jobs.dataUpdatedAt ? `Updated ${agoLabel(jobs.dataUpdatedAt, now)}` : 'Loading…'} · refreshing every 15 s
          </span>
        }
        description="Find deliveries without a partner, handle exceptions and reassign by hand."
      />
      <div className="flex flex-col gap-[18px]">
        <KpiStrip label="Delivery overview">
          <KpiTile label="Unassigned" {...kpi} value={ov ? unassigned : undefined} highlight={unassigned > 0} sub="Finding a partner or offered" />
          <KpiTile label="Offers out" {...kpi} value={ov?.liveOffers} sub="Waiting on a partner" />
          <KpiTile label="In progress" {...kpi} value={ov ? inProgress : undefined} sub="Assigned to on the way" />
          <KpiTile label="Exceptions" {...kpi} value={ov ? <span className={ov.exceptions > 0 ? 'text-bad' : undefined}>{ov.exceptions}</span> : undefined} sub={ov && ov.exceptions > 0 ? 'Need a decision' : 'None open'} subTone={ov && ov.exceptions > 0 ? 'muted' : 'ok'} />
          <KpiTile label="Partners online" {...kpi} value={ov?.partners.online} secondary={ov ? `/${ov.partners.approved ?? ov.partners.byStatus.APPROVED ?? 0}` : undefined} sub={ov ? `${ov.partners.onDelivery ?? 0} on a delivery` : undefined} />
        </KpiStrip>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <SegmentedTabs
            label="Delivery queue"
            value={filter}
            onChange={(v) => setParam({ filter: v })}
            options={[
              { value: 'unassigned', label: 'Unassigned', count: ov?.jobsByStatus.PENDING_ASSIGNMENT },
              { value: 'offered', label: 'Offered', count: ov?.jobsByStatus.OFFERED },
              { value: 'exceptions', label: 'Exceptions', count: ov?.exceptions },
              { value: 'status', label: 'By status' },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            {filter === 'status' ? (
              <Select
                aria-label="Delivery status"
                value={status}
                onChange={(e) => setParam({ status: e.target.value })}
                options={STATUSES.map((s) => ({ value: s, label: statusLabel('delivery', s) }))}
                className="w-48"
              />
            ) : null}
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setParam({ q: draft.trim() || null });
              }}
              className="flex items-center gap-2"
            >
              <Input type="search" icon="search" aria-label="Search by order code or delivery id" placeholder="TH-… or delivery id" value={draft} onChange={(e) => setDraft(e.target.value)} className="w-56" />
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
            </form>
          </div>
        </div>
        {!canOps ? <RoleNote>You can view deliveries. Assigning, unassigning and failing need the Ops role.</RoleNote> : null}

        <DataTable
          caption="Deliveries"
          columns={columns}
          rows={jobs.data?.items}
          getRowId={(j) => j.id}
          loading={jobs.isPending}
          error={jobs.isError ? jobs.error : undefined}
          onRetry={() => jobs.refetch()}
          empty={{
            icon: 'bike',
            title: q ? `No ${filterLabel} deliveries match “${q}”` : filter === 'exceptions' ? 'No exception deliveries' : `No ${filterLabel} deliveries`,
            description: 'This list refreshes every 15 seconds.',
          }}
          rowActions={(j) => {
            if (!canOps) return null;
            const open = !['DELIVERED', 'FAILED', 'CANCELLED'].includes(j.status);
            return (
              <div className="flex flex-wrap justify-end gap-1.5">
                {open ? (
                  <Button size="xs" onClick={() => setPicking(j)}>
                    {j.partnerId ? 'Reassign' : 'Assign'}
                  </Button>
                ) : null}
                {j.partnerId && ['ASSIGNED', 'AT_PICKUP'].includes(j.status) ? (
                  <Button size="xs" variant="outline" onClick={() => setUnassigning(j)}>
                    Unassign
                  </Button>
                ) : null}
                {open ? (
                  <Button size="xs" variant="ghost" onClick={() => setFailing(j)}>
                    Mark failed
                  </Button>
                ) : null}
                {isDemo && SIMULATABLE.has(j.status) && j.partnerId ? (
                  <Button size="xs" variant="outline" loading={simulate.isPending && simulate.variables === j.id} onClick={() => simulate.mutate(j.id)}>
                    <DemoTag /> Simulate movement
                  </Button>
                ) : null}
              </div>
            );
          }}
          footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(jobs.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(jobs.data!.nextCursor!)} page={pages.page} loading={jobs.isFetching} />}
        />
        {jobs.data?.items.length ? <p className="text-[12.5px] text-fg-3">{plural(jobs.data.items.length, 'delivery', 'deliveries')} on this page.</p> : null}
      </div>

      <PartnerPicker job={picking} onClose={() => setPicking(null)} />
      <ConfirmDialog
        open={unassigning !== null}
        onClose={() => setUnassigning(null)}
        title="Unassign this delivery?"
        description="The current partner is released and the delivery goes back to dispatch."
        confirmLabel="Unassign"
        reason={{ label: 'Reason', minLength: 3, options: ['Partner unreachable', 'Partner requested', 'Wrong partner'] }}
        onConfirm={(reason) => unassign.mutateAsync({ id: unassigning!.id, reason })}
      />
      <ConfirmDialog
        open={failing !== null}
        onClose={() => setFailing(null)}
        title="Mark this delivery as failed?"
        description={failing ? <>The customer's order moves to delivery failed so you can cancel and refund it. Delivery <Mono>{jobLabel(failing)}</Mono>.</> : undefined}
        confirmLabel="Mark failed"
        tone="danger"
        reason={{ label: 'Reason', minLength: 3, options: ['Customer unreachable', 'Partner vehicle breakdown', 'Address not found', 'No partner available'] }}
        onConfirm={(reason) => fail.mutateAsync({ id: failing!.id, reason: reason ?? '' })}
      />
    </>
  );
}
