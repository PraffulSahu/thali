/**
 * Notifications by status with per-row retry and NTF-2 bulk retry (`POST /admin/notifications/retry {status}` for
 * FAILED / DEAD; never OTP), plus the demo-only provider outage switch (`POST /admin/notifications/demo/fail-mode`).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusPill } from '../../components/ui/StatusPill';
import { Toggle } from '../../components/ui/Toggle';
import { useMeta } from '../../hooks/useMeta';
import { listNotifications, notificationSummary, qk, retryNotification, setFailMode, type AdminNotification } from './api';
import { useRetryNotifications } from './bulk';
import { useAdminMutation, useAdminRoles } from './shared';
import { DemoTag, FilterPills, RoleNote } from './ui';

function DemoFailMode() {
  const { isDemo } = useMeta();
  const { canOps } = useAdminRoles();
  const [sms, setSms] = useState(false);
  const [email, setEmail] = useState(false);
  const apply = useAdminMutation((v: { sms: boolean; email: boolean }) => setFailMode(v), {
    success: (s) => (s.sms || s.email ? `Simulating provider outage (${[s.sms && 'SMS', s.email && 'email'].filter(Boolean).join(' and ')}) for up to an hour` : 'Provider outage simulation switched off'),
    invalidate: [['admin', 'health']],
  });
  if (!isDemo) return null;
  return (
    <section aria-labelledby="failmode-title" className="flex flex-col gap-3 rounded-field border border-dashed border-line-2 bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="failmode-title" className="font-sans text-[14.5px] font-semibold tracking-normal text-fg">
          Simulate a provider outage
        </h3>
        <DemoTag>DEMO ONLY</DemoTag>
      </div>
      <p className="text-[13px] text-fg-3">Makes the mock SMS or email provider fail so you can watch retries, dead notifications, the Degraded health row and the retry buttons. Resets itself after an hour.</p>
      {canOps ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="inline-flex items-center gap-2.5 text-[13.5px] text-fg">
            <Toggle checked={sms} onChange={setSms} label="SMS provider down" />
            SMS provider down
          </label>
          <label className="inline-flex items-center gap-2.5 text-[13.5px] text-fg">
            <Toggle checked={email} onChange={setEmail} label="Email provider down" />
            Email provider down
          </label>
          <Button size="sm" variant="outline" loading={apply.isPending} onClick={() => apply.mutate({ sms, email })}>
            Apply
          </Button>
        </div>
      ) : (
        <RoleNote>Changing the demo fail mode needs the Ops role</RoleNote>
      )}
    </section>
  );
}

const STATUS_OPTIONS = [
  { value: 'DEAD', label: 'Gave up' },
  { value: 'FAILED', label: 'Failed, retrying' },
  { value: 'QUEUED', label: 'Queued' },
  { value: 'SENT', label: 'Sent' },
] as const;
type ShownStatus = (typeof STATUS_OPTIONS)[number]['value'];

export default function NotificationsPanel({ titleId }: { titleId?: string }) {
  const { canOps, canSupport } = useAdminRoles();
  const [status, setStatus] = useState<ShownStatus>('DEAD');
  const [confirmAll, setConfirmAll] = useState(false);
  const pages = useCursorPages();
  const summary = useQuery({ queryKey: qk.notificationSummary, queryFn: notificationSummary, refetchInterval: 30_000 });
  const query = useQuery({
    queryKey: qk.notifications({ status, cursor: pages.cursor }),
    queryFn: () => listNotifications({ status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const retry = useAdminMutation((id: string) => retryNotification(id), { success: 'Notification re-queued', invalidate: [['admin', 'health']] });
  const retryAll = useRetryNotifications();
  const canRetry = canOps || canSupport;
  const retryable = status === 'FAILED' || status === 'DEAD';
  const counts = summary.data?.byStatus;

  const columns: Column<AdminNotification>[] = [
    { key: 'template', header: 'Notification', cell: (n) => <span><span className="font-mono text-[12.5px]">{n.template}</span> <span className="text-fg-3">({n.channel.toLowerCase().replace('_', '-')})</span></span>, primary: true },
    { key: 'to', header: 'To', cell: (n) => n.to, secondary: true },
    { key: 'status', header: 'Status', cell: (n) => <StatusPill kind="notification" status={n.status} density="dense" /> },
    {
      key: 'error',
      header: 'Last error',
      cell: (n) => (n.lastError ? <span className="block max-w-md whitespace-normal break-words font-mono text-[12px] text-bad">{n.lastError}</span> : <span className="text-fg-3">—</span>),
    },
    { key: 'attempts', header: 'Attempts', cell: (n) => n.attempts, align: 'right', hideOnMobile: true },
    { key: 'updated', header: 'Updated', cell: (n) => <RelativeTime value={n.updatedAt} className="text-fg-3" />, hideOnMobile: true },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-[17px] text-fg">
          Notifications that need attention
        </h2>
        {retryable ? (
          <div className="flex flex-wrap items-center gap-2">
            {!canRetry ? <RoleNote>Retrying needs the Ops or Support role</RoleNote> : null}
            <Button size="sm" variant="outline" icon="refresh" disabled={!canRetry || (counts ? counts[status] === 0 : false)} loading={retryAll.isPending} onClick={() => setConfirmAll(true)}>
              Retry all {status === 'DEAD' ? 'given up' : 'failed'}
              {counts ? ` (${counts[status]})` : ''}
            </Button>
          </div>
        ) : null}
      </div>
      <DemoFailMode />
      <FilterPills
        label="Notification status"
        value={status}
        onChange={(v) => {
          setStatus(v);
          pages.reset();
        }}
        options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: counts ? counts[o.value] : null }))}
      />
      <DataTable
        caption="Notifications"
        columns={columns}
        rows={query.data?.items}
        getRowId={(n) => n.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'bell', title: retryable ? 'No failed notifications' : 'No notifications in this state' }}
        rowActions={(n) =>
          (n.status === 'DEAD' || n.status === 'FAILED') && canRetry ? (
            n.template === 'otp' ? (
              <Badge density="dense">One-time codes can't be retried</Badge>
            ) : (
              <Button size="xs" variant="outline" icon="refresh" loading={retry.isPending && retry.variables === n.id} onClick={() => retry.mutate(n.id)}>
                Retry send
              </Button>
            )
          ) : null
        }
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={`Retry every ${status === 'DEAD' ? 'given-up' : 'failed'} notification?`}
        description="Up to 500 notifications are re-queued, oldest first. One-time codes and notifications without a recipient are never resent. Recorded in the audit log."
        confirmLabel="Retry all"
        onConfirm={() => retryAll.mutateAsync({ statuses: [status as 'FAILED' | 'DEAD'], asked: counts ? counts[status] : 0 })}
      />
    </>
  );
}
