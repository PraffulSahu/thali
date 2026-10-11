/**
 * `/admin` — board 40 "Today at a glance". Every figure comes from a live endpoint; each source loads and fails
 * on its own (a failing service shows "Stats unavailable · Retry", never zeros):
 *   KPIs        ORD-2 `GET /admin/orders/overview` · DLV-5 `GET /admin/delivery/overview` · `GET /admin/marketplace/overview`
 *   status bar  ORD-2 `today.byStatus` (five groups + "Failed" only when > 0)
 *   attention   `GET /admin/delivery/jobs?exception=true` (Assign → DLV-7 picker) · pending restaurants (Approve, email-verified
 *               gating) · pending partners (Review)
 *   health      GW-1 `GET /admin/health` (summary / degradedReasons; a failing provider is Degraded, never Down) ·
 *               dead letters from health `details.deadLetters` → NTF-3 bulk replay · NTF-1 FAILED + DEAD → NTF-2 bulk retry
 *   recent      ORD-1 `GET /admin/orders/checkouts` (status + day filters, View all → /admin/orders)
 * No realtime here: auto-refresh every 30 s plus Refresh, with "refreshed Ns ago".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, ButtonLink } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { KpiStrip, KpiTile } from '../../components/ui/KpiTile';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { formatPaise } from '../../components/ui/Price';
import { Skeleton } from '../../components/ui/Skeleton';
import { StackedStatusBar, type StatusSegment } from '../../components/ui/StackedStatusBar';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { useToast } from '../../components/ui/Toast';
import { AccentWord } from '../../components/ui/Typography';
import { errorMessage } from '../../lib/errors';
import { plural } from '../../lib/format';
import {
  deadLetterCount, listCheckouts, listJobs, listPartners, listRestaurants, notificationSummary, qk, replayAllDeadLetters,
  restaurantAction, retryableCount, retryAllNotifications, type AdminJob, type AdminPartner, type AdminRestaurant, type HealthReport,
  type NotificationSummary, type OrdersOverview,
} from './api';
import { PartnerPicker, jobLabel } from './PartnerPicker';
import { useAdminRoles } from './shared';
import { unassignedCount, useHealth, useMarketplaceOverview, useOrdersOverview, useTmsOverview } from './shell';
import {
  agoLabel, ageLabel, CHECKOUT_STATUS_OPTIONS, CheckoutsTable, DATE_RANGES, istDayLabel, istToday, PillSelect, rangeToIso, RoleNote, useNow,
  type DateRange,
} from './ui';

const REFRESH_MS = 30_000;

/** KPI money: drop ".00" on whole rupees ("₹28,416"), keep paise otherwise ("₹1,204.20"). */
export function kpiMoney(paise: number): string {
  const s = formatPaise(paise);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

/** Board 40 status bar groups (design-spec-overrides: five groups, "Failed" only when > 0). */
export function statusSegments(byStatus: Record<string, number>): StatusSegment[] {
  const n = (...keys: string[]) => keys.reduce((s, k) => s + (byStatus[k] ?? 0), 0);
  return [
    { key: 'delivered', label: 'Delivered', count: n('DELIVERED'), tone: 'ok' },
    { key: 'progress', label: 'In progress', count: n('ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'), tone: 'acc' },
    { key: 'placed', label: 'Placed', count: n('PLACED', 'AWAITING_PAYMENT'), tone: 'info' },
    { key: 'rejected', label: 'Rejected', count: n('REJECTED'), tone: 'bad' },
    { key: 'cancelled', label: 'Cancelled', count: n('CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'), tone: 'neu' },
    { key: 'failed', label: 'Failed', count: n('DELIVERY_FAILED'), tone: 'neu', hideWhenZero: true },
  ];
}

/* ------------------------------------------------------------------ KPI strip */

function Kpis({ orders, market, tms }: { orders: ReturnType<typeof useOrdersOverview>; market: ReturnType<typeof useMarketplaceOverview>; tms: ReturnType<typeof useTmsOverview> }) {
  const o = orders.data;
  const t = tms.data;
  const m = market.data;
  const pendingPartners = t?.partners.byStatus.APPROVAL_PENDING ?? 0;
  const unassigned = unassignedCount(t) ?? 0;
  const failed = o?.refundsFailed ?? 0;
  const approvalsUnavailable = market.isError || tms.isError;
  return (
    <KpiStrip label="Today's key figures">
      <KpiTile
        label="Orders"
        loading={orders.isPending}
        unavailable={orders.isError}
        onRetry={() => void orders.refetch()}
        value={o?.today.checkouts}
        sub={o ? plural(o.today.placed, 'child order') : undefined}
      />
      <KpiTile
        label="GMV"
        loading={orders.isPending}
        unavailable={orders.isError}
        onRetry={() => void orders.refetch()}
        value={o ? kpiMoney(o.today.gmvPaise) : undefined}
        sub={o ? `${formatPaise(o.today.refundedPaise)} refunded` : undefined}
      />
      <KpiTile
        label="Partners online"
        loading={tms.isPending}
        unavailable={tms.isError}
        onRetry={() => void tms.refetch()}
        value={t?.partners.online}
        secondary={t ? `/${t.partners.approved ?? t.partners.byStatus.APPROVED ?? 0}` : undefined}
        sub={t ? `${t.partners.onDelivery ?? 0} on a delivery` : undefined}
      />
      <KpiTile
        label="Unassigned"
        loading={tms.isPending}
        unavailable={tms.isError}
        onRetry={() => void tms.refetch()}
        highlight={unassigned > 0}
        value={t ? unassigned : undefined}
        sub={<Link to="/admin/tms?filter=unassigned" className="underline underline-offset-2">Open deliveries →</Link>}
      />
      <KpiTile
        label="Approvals"
        loading={market.isPending || tms.isPending}
        unavailable={approvalsUnavailable}
        onRetry={() => {
          if (market.isError) void market.refetch();
          if (tms.isError) void tms.refetch();
        }}
        value={
          m && t ? (
            <Link to="/admin/restaurants?status=APPROVAL_PENDING" className="hover:underline">
              {m.restaurants.pendingApproval + pendingPartners}
            </Link>
          ) : undefined
        }
        sub={
          m && t ? (
            <>
              <Link to="/admin/restaurants?status=APPROVAL_PENDING" className="hover:text-fg hover:underline">{plural(m.restaurants.pendingApproval, 'restaurant')}</Link>
              {' · '}
              <Link to="/admin/partners?status=APPROVAL_PENDING" className="hover:text-fg hover:underline">{plural(pendingPartners, 'partner')}</Link>
            </>
          ) : undefined
        }
      />
      <KpiTile
        label="Failed refunds"
        loading={orders.isPending}
        unavailable={orders.isError}
        onRetry={() => void orders.refetch()}
        value={o ? <span className={failed > 0 ? 'text-bad' : undefined}>{failed}</span> : undefined}
        subTone={failed > 0 ? 'muted' : 'ok'}
        sub={
          o ? (
            failed > 0 ? (
              <Link to="/admin/finance?tab=refunds&status=FAILED" className="font-semibold text-bad underline underline-offset-2">Retry →</Link>
            ) : (
              'Nothing to retry'
            )
          ) : undefined
        }
      />
    </KpiStrip>
  );
}

function StatusBarCard({ orders }: { orders: { data?: OrdersOverview; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (orders.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3 rounded-field border border-line bg-card px-[18px] py-4">
        <span className="sr-only">Loading child orders by status…</span>
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }
  if (orders.isError || !orders.data) {
    return <ErrorState compact title="Child orders by status unavailable" error={orders.error} onRetry={() => void orders.refetch()} />;
  }
  return <StackedStatusBar title="Child orders by status" segments={statusSegments(orders.data.today.byStatus)} />;
}

/* ------------------------------------------------------------------ needs attention */

function Row({ pill, title, sub, subTone, action, note }: { pill: ReactNode; title: ReactNode; sub: ReactNode; subTone?: 'warn'; action: ReactNode; note?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
      {pill}
      <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
        {title}
        <span className={subTone === 'warn' ? 'text-[12.5px] text-warn' : 'text-[12.5px] text-fg-3'}>{sub}</span>
        {note}
      </span>
      {action}
    </li>
  );
}

function SourceProblem({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
      <span className="flex-1 text-[13px] text-bad">
        Couldn't load {what}: {errorMessage(error)}
      </span>
      <Button size="xs" variant="outline" icon="refresh" onClick={onRetry}>
        Retry
      </Button>
    </li>
  );
}

const DOC_SHORT: Record<string, string> = { ID_PROOF: 'ID', DRIVING_LICENSE: 'licence', VEHICLE_RC: 'RC', SELFIE: 'selfie' };
function docsLine(p: AdminPartner): string {
  if (!p.documents.length) return 'No documents uploaded yet';
  const names = p.documents.map((d) => DOC_SHORT[d.type] ?? humanize(d.type).toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]!;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} uploaded`;
}

function NeedsAttention({ now }: { now: number }) {
  const { canOps } = useAdminRoles();
  const qc = useQueryClient();
  const { toast } = useToast();
  const exceptions = useQuery({ queryKey: qk.jobs({ exception: true, overview: true }), queryFn: () => listJobs({ exception: true, limit: 5 }), refetchInterval: REFRESH_MS });
  const restaurants = useQuery({ queryKey: qk.restaurants({ status: 'APPROVAL_PENDING', overview: true }), queryFn: () => listRestaurants({ status: 'APPROVAL_PENDING', limit: 5 }), refetchInterval: REFRESH_MS });
  const partners = useQuery({ queryKey: qk.partners({ status: 'APPROVAL_PENDING', overview: true }), queryFn: () => listPartners({ status: 'APPROVAL_PENDING', limit: 5 }), refetchInterval: REFRESH_MS });
  const [assigning, setAssigning] = useState<AdminJob | null>(null);
  const [approving, setApproving] = useState<AdminRestaurant | null>(null);

  const approve = async (r: AdminRestaurant) => {
    try {
      await restaurantAction(r.id, 'approve');
      toast({ title: `${r.name} approved`, tone: 'success' });
      await Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'restaurants'] }), qc.invalidateQueries({ queryKey: qk.overview('marketplace') })]);
    } catch (e) {
      toast({ title: "Couldn't approve", description: errorMessage(e), tone: 'danger' });
      throw e;
    }
  };

  const jobs = exceptions.data?.items ?? [];
  const rs = restaurants.data?.items ?? [];
  const ps = partners.data?.items ?? [];
  const loading = exceptions.isPending || restaurants.isPending || partners.isPending;
  const count = jobs.length + rs.length + ps.length;
  const nothing = !loading && count === 0 && !exceptions.isError && !restaurants.isError && !partners.isError;

  return (
    <SectionCard title="Needs attention" count={loading ? undefined : count}>
      <ul aria-label="Needs attention" aria-busy={loading || undefined}>
        {exceptions.isError ? <SourceProblem what="delivery exceptions" error={exceptions.error} onRetry={() => void exceptions.refetch()} /> : null}
        {jobs.map((j) => (
          <Row
            key={j.id}
            pill={<StatusPill kind="delivery" status={j.status} density="dense" />}
            title={<span className="font-mono text-[13px] text-fg">{jobLabel(j)}</span>}
            sub={`${j.pickup.name} · ${j.exceptionReason ?? `no partner after ${plural(j.dispatchRound, 'round')}`} · ${ageLabel(j.createdAt, now)}`}
            note={!canOps ? <RoleNote>Your role can't assign deliveries</RoleNote> : undefined}
            action={
              <Button size="sm" onClick={() => setAssigning(j)} disabled={!canOps}>
                {j.partnerId ? 'Reassign' : 'Assign'}
              </Button>
            }
          />
        ))}
        {restaurants.isError ? <SourceProblem what="restaurant approvals" error={restaurants.error} onRetry={() => void restaurants.refetch()} /> : null}
        {rs.map((r) => {
          const blocked = !r.emailVerified;
          return (
            <Row
              key={r.id}
              pill={<StatusPill kind="restaurant" status={r.status} density="dense" />}
              title={
                <Link to={`/admin/restaurants/${r.id}`} className="text-[13.5px] font-medium text-fg hover:underline">
                  {r.name}
                </Link>
              }
              subTone={blocked ? 'warn' : undefined}
              sub={blocked ? 'Approve unlocks after business email is verified' : `Business email verified · ${r.documents.filter((d) => d.verified).length}/${r.documents.length} documents verified`}
              note={!canOps ? <RoleNote>Your role can't approve restaurants</RoleNote> : undefined}
              action={
                <Button size="sm" variant="outline" disabled={blocked || !canOps} onClick={() => setApproving(r)}>
                  Approve
                </Button>
              }
            />
          );
        })}
        {partners.isError ? <SourceProblem what="partner approvals" error={partners.error} onRetry={() => void partners.refetch()} /> : null}
        {ps.map((p) => (
          <Row
            key={p.id}
            pill={<StatusPill kind="partner" status={p.status} density="dense" />}
            title={<span className="text-[13.5px] font-medium text-fg">{p.name}{p.vehicle ? ` · ${humanize(p.vehicle.type)}` : ''}</span>}
            sub={docsLine(p)}
            action={
              <ButtonLink to={`/admin/partners/${p.id}`} size="sm" variant="outline">
                Review
              </ButtonLink>
            }
          />
        ))}
        {loading
          ? Array.from({ length: 3 }, (_, i) => (
              <li key={`sk${i}`} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                <Skeleton className="h-[22px] w-28 rounded-pill" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </span>
              </li>
            ))
          : null}
        {nothing ? (
          <li className="flex items-center gap-2.5 px-4 py-5 text-[13.5px] text-fg-3">
            <span aria-hidden="true" className="size-2 rounded-full bg-ok" />
            Nothing needs attention: no delivery exceptions and no pending approvals.
          </li>
        ) : null}
      </ul>
      <PartnerPicker job={assigning} onClose={() => setAssigning(null)} />
      <ConfirmDialog
        open={approving !== null}
        onClose={() => setApproving(null)}
        title={approving ? `Approve ${approving.name}?` : 'Approve?'}
        description="The restaurant goes live in discovery and the owner is notified. This is recorded in the audit log."
        confirmLabel="Approve"
        onConfirm={() => approve(approving!)}
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ system health */

export interface HealthRow {
  key: string;
  name: string;
  status: 'up' | 'degraded' | 'down';
  text: string;
}

/** Board 40 grouping: each down/degraded service on its own row with its real reason; healthy ones grouped. */
export function healthRows(report: HealthReport): HealthRow[] {
  const entries = Object.entries(report.services);
  const rank = { down: 0, degraded: 1, up: 2 } as const;
  const bad = entries
    .filter(([, s]) => s.status !== 'up')
    .sort((a, b) => rank[a[1].status] - rank[b[1].status])
    .map(([name, s]) => ({
      key: name,
      name,
      status: s.status,
      text: s.status === 'down' ? s.error ?? s.summary ?? 'No response' : s.degradedReasons?.length ? s.degradedReasons.join('; ') : s.summary ?? 'Degraded',
    }));
  const up = entries.filter(([, s]) => s.status === 'up');
  const rows: HealthRow[] = [...bad];
  if (up.length) {
    const lag = Math.max(0, ...up.map(([, s]) => (typeof s.details?.outboxOldestAgeSec === 'number' ? s.details.outboxOldestAgeSec : 0)));
    rows.push({ key: 'up', name: up.map(([n]) => n).join(' · '), status: 'up', text: lag <= 1 ? 'event lag under 1s' : `oldest event waiting ${Math.round(lag)}s` });
  }
  rows.push({
    key: 'gateway',
    name: 'gateway · redis',
    status: report.gateway.status === 'up' ? 'up' : 'degraded',
    text: report.gateway.redis === 'down' ? 'Gateway Redis down: rate limits and realtime fan-out affected' : '—',
  });
  return rows;
}

function useBulkActions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const replay = useMutation({
    mutationFn: () => replayAllDeadLetters({}),
    onSuccess: async (r) => {
      toast({
        title: r.failed.length ? `Replayed ${r.replayed}, ${r.failed.length} failed` : `Replayed ${plural(r.replayed, 'dead letter')}`,
        description: r.failed.length ? `${r.failed[0]!.service}: ${r.failed[0]!.error}. See Health for details.` : undefined,
        tone: r.failed.length ? 'warn' : 'success',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (e) => toast({ title: "Couldn't replay dead letters", description: errorMessage(e), tone: 'danger' }),
  });
  const retry = useMutation({
    mutationFn: async (summary: NotificationSummary) => {
      let queued = 0;
      if ((summary.byStatus.FAILED ?? 0) > 0) queued += (await retryAllNotifications({ status: 'FAILED' })).queued;
      if ((summary.byStatus.DEAD ?? 0) > 0) queued += (await retryAllNotifications({ status: 'DEAD' })).queued;
      return { queued, asked: retryableCount(summary) };
    },
    onSuccess: async ({ queued, asked }) => {
      toast({
        title: `Re-queued ${plural(queued, 'notification')}`,
        description: queued < asked ? 'One-time codes and notifications without a recipient are never retried.' : undefined,
        tone: 'success',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (e) => toast({ title: "Couldn't retry notifications", description: errorMessage(e), tone: 'danger' }),
  });
  return { replay, retry };
}

const TEXT_TONE = { up: 'text-fg-3', degraded: 'text-warn font-mono text-[12px]', down: 'text-bad font-mono text-[12px]' } as const;

function SystemHealth({ health, summary, now }: { health: ReturnType<typeof useHealth>; summary: { data?: NotificationSummary; isError: boolean }; now: number }) {
  const { canOps, canSupport } = useAdminRoles();
  const { replay, retry } = useBulkActions();
  const [confirm, setConfirm] = useState<'replay' | 'retry' | null>(null);
  const dead = deadLetterCount(health.data);
  const failed = retryableCount(summary.data);
  return (
    <SectionCard title="System health" meta={health.data ? `checked ${agoLabel(health.data.checkedAt, now)}` : undefined}>
      {health.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2.5 p-4">
          <span className="sr-only">Checking every service…</span>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : health.isError || !health.data ? (
        <ErrorState compact title="Couldn't check system health" error={health.error} onRetry={() => void health.refetch()} className="border-0" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="sr-only">Service health</caption>
            <tbody>
              {healthRows(health.data).map((r) => (
                <tr key={r.key} data-status={r.status} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3.5 py-[11px] text-left text-[13.5px] font-medium text-fg">
                    {r.name}
                  </th>
                  <td className="px-3.5 py-[11px]">
                    <StatusPill kind="health" status={r.status} density="dense" />
                  </td>
                  <td className={`px-3.5 py-[11px] text-[12.5px] ${TEXT_TONE[r.status]} break-words`}>{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dead > 0 || failed > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {dead > 0 ? (
            <Button size="sm" variant="outline" loading={replay.isPending} disabled={!canOps} onClick={() => setConfirm('replay')}>
              {plural(dead, 'dead letter')} · Replay
            </Button>
          ) : null}
          {failed > 0 ? (
            <Button size="sm" variant="outline" loading={retry.isPending} disabled={!(canOps || canSupport)} onClick={() => setConfirm('retry')}>
              {plural(failed, 'failed notification')} · Retry
            </Button>
          ) : null}
          {!canOps ? <RoleNote>Replaying events needs the Ops role</RoleNote> : null}
          <Link to="/admin/health#dead-letters" className="ml-auto text-[12.5px] text-fg-3 underline underline-offset-2 hover:text-fg">
            Details
          </Link>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm === 'replay'}
        onClose={() => setConfirm(null)}
        title={`Replay ${plural(dead, 'dead letter')}?`}
        description="Every unreplayed dead-lettered event is processed again, oldest first. Handlers are idempotent, and the replay is recorded in the audit log."
        confirmLabel="Replay all"
        onConfirm={() => replay.mutateAsync()}
      />
      <ConfirmDialog
        open={confirm === 'retry'}
        onClose={() => setConfirm(null)}
        title={`Retry ${plural(failed, 'failed notification')}?`}
        description="Failed and given-up SMS and email notifications are re-queued. One-time codes are never resent. Recorded in the audit log."
        confirmLabel="Retry all"
        onConfirm={() => retry.mutateAsync(summary.data!)}
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ recent orders */

function RecentOrders() {
  const [status, setStatus] = useState('ALL');
  const [range, setRange] = useState<DateRange>('today');
  const day = istToday();
  const query = useQuery({
    queryKey: qk.checkouts({ status, range, day, limit: 5 }),
    queryFn: () => listCheckouts({ status: status === 'ALL' ? undefined : status, ...rangeToIso(range), limit: 5 }),
    refetchInterval: REFRESH_MS,
  });
  const rangeLabel = DATE_RANGES.find((r) => r.value === range)?.label.toLowerCase() ?? '';
  return (
    <SectionCard
      title="Recent orders"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <PillSelect label="Order status" prefix="Status:" value={status} onChange={setStatus} options={CHECKOUT_STATUS_OPTIONS} />
          <PillSelect label="Placed" value={range} onChange={setRange} options={DATE_RANGES.filter((r) => r.value !== 'all')} />
          <ButtonLink to={`/admin/orders?status=${status}&range=${range}`} variant="ghost" size="xs">
            View all →
          </ButtonLink>
        </div>
      }
    >
      <CheckoutsTable
        caption="Recent orders"
        rows={query.data?.items}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        showDate={range !== 'today'}
        empty={{ title: `No orders ${status === 'ALL' ? '' : `with status “${CHECKOUT_STATUS_OPTIONS.find((o) => o.value === status)?.label}” `}placed ${rangeLabel}` }}
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ page */

export default function OverviewPage() {
  const now = useNow();
  const qc = useQueryClient();
  const orders = useOrdersOverview(REFRESH_MS);
  const market = useMarketplaceOverview(REFRESH_MS);
  const tms = useTmsOverview(REFRESH_MS);
  const health = useHealth(REFRESH_MS);
  const summary = useQuery({ queryKey: qk.notificationSummary, queryFn: notificationSummary, refetchInterval: REFRESH_MS });
  const [refreshing, setRefreshing] = useState(false);

  const updated = Math.max(orders.dataUpdatedAt, market.dataUpdatedAt, tms.dataUpdatedAt, health.dataUpdatedAt);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await qc.refetchQueries({ queryKey: ['admin'], type: 'active' });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-[18px] [&>header]:mb-0">
      <PageHeader
        title={
          <>
            Today at a <AccentWord>glance</AccentWord>
          </>
        }
        documentTitle="Overview"
        meta={
          <span>
            {istDayLabel(now)} · IST{updated ? ` · refreshed ${agoLabel(updated, now)}` : ''}
          </span>
        }
        actions={
          <Button variant="outline" icon="refresh" loading={refreshing} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      <Kpis orders={orders} market={market} tms={tms} />
      <StatusBarCard orders={orders} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] items-start gap-3.5">
        <NeedsAttention now={now} />
        <SystemHealth health={health} summary={summary} now={now} />
      </div>
      <RecentOrders />
    </div>
  );
}
