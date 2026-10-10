/**
 * `/admin/tms`: delivery operations. Unassigned and exception jobs, manual assign / reassign with a partner
 * picker, unassign, mark failed, and (demo mode only) the location simulator. Reads: any admin; changes: OPS.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { QueryState } from '../../components/ui/QueryState';
import { RadioGroup } from '../../components/ui/Radio';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Select } from '../../components/ui/Select';
import { StatusPill, statusLabel } from '../../components/ui/StatusPill';
import { useMeta } from '../../hooks/useMeta';
import { formatDistanceKm, formatMinutes } from '../../lib/format';
import { assignJob, failJob, listJobs, listPartners, qk, simulateJob, tmsOverview, unassignJob, type AdminJob, type AdminPartner } from './api';
import { DemoBadge, Mono, StatTile, useAdminMutation, useAdminRoles } from './shared';

const POLL_MS = 15_000;
const STATUSES = ['PENDING_ASSIGNMENT', 'OFFERED', 'ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'FAILED', 'DELIVERED', 'CANCELLED'];
const SIMULATABLE = new Set(['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY']);

function PartnerPicker({ job, open, onClose }: { job: AdminJob | null; open: boolean; onClose: () => void }) {
  const [partnerId, setPartnerId] = useState('');
  const partners = useQuery({
    queryKey: qk.partners({ status: 'APPROVED', picker: true }),
    queryFn: () => listPartners({ status: 'APPROVED', limit: 100 }),
    enabled: open,
  });
  const assign = useAdminMutation((v: { jobId: string; partnerId: string }) => assignJob(v.jobId, v.partnerId), {
    success: (_d, v) => (job?.partnerId ? 'Delivery reassigned' : `Delivery assigned (${v.partnerId.slice(-4)})`),
    invalidate: [['admin', 'tms'], ['admin', 'partners']],
  });
  const [error, setError] = useState<unknown>(null);

  const options = useMemo(() => {
    const list = (partners.data?.items ?? []).filter((p) => p.id !== job?.partnerId);
    const free = (p: AdminPartner) => p.activeJobIds.length < p.maxActive;
    list.sort((a, b) => Number(b.online && free(b)) - Number(a.online && free(a)) || a.name.localeCompare(b.name));
    return list.map((p) => {
      const blocked = !p.online ? 'Offline' : !free(p) ? 'At delivery limit' : null;
      return {
        value: p.id,
        disabled: blocked !== null,
        label: p.name,
        description: (
          <span className="text-sm text-slate-600">
            {p.online ? 'Online' : 'Offline'} · {p.activeJobIds.length}/{p.maxActive} deliveries
            {p.lastLocationAt ? <> · <RelativeTime value={p.lastLocationAt} prefix="seen" /></> : ''}
          </span>
        ),
        aside: blocked ? <Badge>{blocked}</Badge> : <Badge tone="success">Available</Badge>,
      };
    });
  }, [partners.data, job?.partnerId]);

  const submit = async () => {
    if (!job || !partnerId) return;
    setError(null);
    try {
      await assign.mutateAsync({ jobId: job.id, partnerId });
      setPartnerId('');
      onClose();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={job?.partnerId ? 'Reassign delivery' : 'Assign a partner'}
      description={job ? `${job.pickup.name} to ${job.drop.address}` : undefined}
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!partnerId} loading={assign.isPending}>
            {job?.partnerId ? 'Reassign' : 'Assign'}
          </Button>
        </FormActions>
      }
    >
      <QueryState query={partners} isEmpty={(d) => d.items.length === 0} empty={{ icon: 'bike', title: 'No approved partners', description: 'Approve a delivery partner first.', compact: true }}>
        {() => (
          <div className="flex flex-col gap-3">
            {options.length === 0 ? (
              <p className="text-sm text-slate-600">No other approved partners to choose from.</p>
            ) : (
              <RadioGroup legend="Partner" name="partner" variant="cards" value={partnerId} onChange={setPartnerId} options={options} hint="Only online partners under their delivery limit can be assigned." />
            )}
            <InlineError error={error} />
          </div>
        )}
      </QueryState>
    </Dialog>
  );
}

export default function TmsPage() {
  const { canOps } = useAdminRoles();
  const { isDemo } = useMeta();
  const [status, setStatus] = useState('PENDING_ASSIGNMENT');
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [picking, setPicking] = useState<AdminJob | null>(null);
  const [unassigning, setUnassigning] = useState<AdminJob | null>(null);
  const [failing, setFailing] = useState<AdminJob | null>(null);
  const pages = useCursorPages();

  const overview = useQuery({ queryKey: qk.tmsOverview, queryFn: tmsOverview, refetchInterval: POLL_MS });
  const jobs = useQuery({
    queryKey: qk.jobs({ status, exceptionsOnly, cursor: pages.cursor }),
    queryFn: () => listJobs({ status: exceptionsOnly ? undefined : status, exception: exceptionsOnly ? true : undefined, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
  });
  const names = useQuery({ queryKey: qk.partners({ status: 'APPROVED', picker: true }), queryFn: () => listPartners({ status: 'APPROVED', limit: 100 }), staleTime: 60_000 });
  const partnerName = (id: string | null) => (id ? names.data?.items.find((p) => p.id === id)?.name ?? `Partner …${id.slice(-4)}` : null);

  const unassign = useAdminMutation((v: { id: string; reason?: string }) => unassignJob(v.id, v.reason), { success: 'Delivery unassigned and re-dispatching', invalidate: [['admin', 'tms']] });
  const fail = useAdminMutation((v: { id: string; reason: string }) => failJob(v.id, v.reason), { success: 'Delivery marked failed', invalidate: [['admin', 'tms']] });
  const simulate = useAdminMutation((id: string) => simulateJob(id), { success: (d) => `Demo simulation started: ${d.steps} location updates`, invalidate: [['admin', 'tms']] });

  const columns: Column<AdminJob>[] = [
    { key: 'order', header: 'Pickup', cell: (j) => j.pickup.name, primary: true },
    { key: 'drop', header: 'Drop-off', cell: (j) => j.drop.address, secondary: true },
    { key: 'status', header: 'Status', cell: (j) => <StatusPill kind="delivery" status={j.status} /> },
    {
      key: 'exception',
      header: 'Attention',
      cell: (j) => (j.exception ? <Badge tone="danger" icon="alert">{j.exceptionReason ?? 'Exception'}</Badge> : j.failureReason ? <span className="text-sm text-danger-700">{j.failureReason}</span> : '-'),
    },
    { key: 'partner', header: 'Partner', cell: (j) => partnerName(j.partnerId) ?? 'Unassigned' },
    {
      key: 'eta',
      header: 'Trip',
      cell: (j) => (
        <span>
          {formatDistanceKm(j.distanceKm)} · {formatMinutes(j.estimatedMinutes)} {j.estimateSource !== 'GOOGLE' ? <DemoBadge label="Estimate" /> : null}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'age', header: 'Created', cell: (j) => <RelativeTime value={j.createdAt} />, hideOnMobile: true },
  ];

  const ov = overview.data;
  const inProgress = ov ? ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'].reduce((n, s) => n + (ov.jobsByStatus[s] ?? 0), 0) : 0;

  return (
    <>
      <PageHeader
        title="Deliveries"
        description="Find deliveries without a partner, handle exceptions, and reassign by hand."
        actions={
          <span className="text-sm text-slate-600" aria-live="polite">
            {jobs.dataUpdatedAt ? <RelativeTime value={jobs.dataUpdatedAt} prefix="Updated" /> : null}
          </span>
        }
      />
      <section aria-label="Delivery overview" className="mb-6">
        <QueryState query={overview} loading={<div className="h-24" />} errorTitle="Couldn't load the delivery overview">
          {() => (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatTile label="Needs a partner" value={ov?.jobsByStatus.PENDING_ASSIGNMENT ?? 0} tone={(ov?.jobsByStatus.PENDING_ASSIGNMENT ?? 0) > 0 ? 'warn' : undefined} />
              <StatTile label="Offers out" value={ov?.liveOffers ?? 0} />
              <StatTile label="In progress" value={inProgress} />
              <StatTile label="Exceptions" value={ov?.exceptions ?? 0} tone={(ov?.exceptions ?? 0) > 0 ? 'danger' : undefined} />
              <StatTile label="Partners online" value={ov?.partners.online ?? 0} />
            </div>
          )}
        </QueryState>
      </section>

      <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
        <Field label="Delivery status">
          <Select value={status} disabled={exceptionsOnly} onChange={(e) => { setStatus(e.target.value); pages.reset(); }} options={STATUSES.map((s) => ({ value: s, label: statusLabel('delivery', s) }))} />
        </Field>
        <Checkbox label="Exceptions only" description="Deliveries nobody accepted or that need a decision" checked={exceptionsOnly} onChange={(e) => { setExceptionsOnly(e.target.checked); pages.reset(); }} />
      </div>
      {!canOps ? <p role="note" className="mb-3 text-sm text-slate-600">You can view deliveries. Assigning needs the Ops admin role.</p> : null}

      <DataTable
        caption="Deliveries"
        columns={columns}
        rows={jobs.data?.items}
        getRowId={(j) => j.id}
        loading={jobs.isPending}
        error={jobs.isError ? jobs.error : undefined}
        onRetry={() => jobs.refetch()}
        empty={{ icon: 'bike', title: exceptionsOnly ? 'No exception deliveries' : `No deliveries ${statusLabel('delivery', status).toLowerCase()}`, description: 'This list refreshes every 15 seconds.' }}
        rowActions={(j) => {
          if (!canOps) return null;
          const open = !['DELIVERED', 'FAILED', 'CANCELLED'].includes(j.status);
          return (
            <div className="flex flex-wrap gap-2">
              {open ? (
                <Button size="sm" onClick={() => setPicking(j)}>
                  {j.partnerId ? 'Reassign' : 'Assign'}
                </Button>
              ) : null}
              {j.partnerId && ['ASSIGNED', 'AT_PICKUP'].includes(j.status) ? (
                <Button size="sm" variant="secondary" onClick={() => setUnassigning(j)}>
                  Unassign
                </Button>
              ) : null}
              {open ? (
                <Button size="sm" variant="ghost" onClick={() => setFailing(j)}>
                  Mark failed
                </Button>
              ) : null}
              {isDemo && canSimulate(j) ? (
                <Button size="sm" variant="secondary" loading={simulate.isPending && simulate.variables === j.id} onClick={() => simulate.mutate(j.id)}>
                  Simulate (demo)
                </Button>
              ) : null}
            </div>
          );
        }}
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(jobs.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(jobs.data!.nextCursor!)} page={pages.page} loading={jobs.isFetching} />}
      />

      <PartnerPicker job={picking} open={picking !== null} onClose={() => setPicking(null)} />
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
        description={failing ? <>The customer's order moves to delivery failed so you can cancel and refund it. Delivery <Mono>{failing.id}</Mono>.</> : undefined}
        confirmLabel="Mark failed"
        tone="danger"
        reason={{ label: 'Reason', minLength: 3, options: ['Customer unreachable', 'Partner vehicle breakdown', 'Address not found', 'No partner available'] }}
        onConfirm={(reason) => fail.mutateAsync({ id: failing!.id, reason: reason ?? '' })}
      />
    </>
  );
}

function canSimulate(j: AdminJob): boolean {
  return SIMULATABLE.has(j.status) && j.partnerId !== null;
}
