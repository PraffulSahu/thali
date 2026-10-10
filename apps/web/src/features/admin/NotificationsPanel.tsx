/** Failed or dead notifications with a retry action; plus the demo-only provider outage switch. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';
import { useMeta } from '../../hooks/useMeta';
import { listNotifications, qk, retryNotification, setFailMode, type AdminNotification } from './api';
import { DemoBadge, useAdminMutation, useAdminRoles } from './shared';

function DemoFailMode() {
  const { isDemo } = useMeta();
  const { canOps } = useAdminRoles();
  const [sms, setSms] = useState(false);
  const [email, setEmail] = useState(false);
  const apply = useAdminMutation((v: { sms: boolean; email: boolean }) => setFailMode(v), {
    success: (s) => (s.sms || s.email ? `Simulating provider outage (${[s.sms && 'SMS', s.email && 'email'].filter(Boolean).join(' and ')}) for up to an hour` : 'Provider outage simulation switched off'),
  });
  if (!isDemo || !canOps) return null;
  return (
    <Card tone="muted">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">Simulate a provider outage <DemoBadge label="Demo only" /></h3>
          <p className="text-sm text-slate-600">Makes the mock SMS or email provider fail so you can watch retries, dead notifications and the retry button. Resets itself after an hour.</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-6">
        <Checkbox label="SMS provider down" checked={sms} onChange={(e) => setSms(e.target.checked)} />
        <Checkbox label="Email provider down" checked={email} onChange={(e) => setEmail(e.target.checked)} />
        <Button variant="secondary" loading={apply.isPending} onClick={() => apply.mutate({ sms, email })}>
          Apply
        </Button>
      </div>
    </Card>
  );
}

export default function NotificationsPanel() {
  const { canOps, canSupport } = useAdminRoles();
  const [status, setStatus] = useState('DEAD');
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: qk.notifications({ status, cursor: pages.cursor }),
    queryFn: () => listNotifications({ status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const retry = useAdminMutation((id: string) => retryNotification(id), { success: 'Notification re-queued', invalidate: [['admin', 'health', 'notifications']] });

  const columns: Column<AdminNotification>[] = [
    { key: 'template', header: 'Notification', cell: (n) => `${n.template} (${n.channel.toLowerCase().replace('_', '-')})`, primary: true },
    { key: 'to', header: 'To', cell: (n) => n.to, secondary: true },
    { key: 'status', header: 'Status', cell: (n) => <StatusPill kind="notification" status={n.status} /> },
    {
      key: 'error',
      header: 'Last error',
      cell: (n) => (n.lastError ? <span className="break-words text-sm text-danger-700">{n.lastError}</span> : <span className="text-slate-500">-</span>),
    },
    { key: 'attempts', header: 'Attempts', cell: (n) => n.attempts, align: 'right', hideOnMobile: true },
    { key: 'updated', header: 'Updated', cell: (n) => <RelativeTime value={n.updatedAt} />, hideOnMobile: true },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DemoFailMode />
      <Field label="Show" className="w-full sm:w-64">
        <Select
          value={status}
          onChange={(e) => { setStatus(e.target.value); pages.reset(); }}
          options={[
            { value: 'DEAD', label: 'Gave up (dead)' },
            { value: 'FAILED', label: 'Failed, still retrying' },
            { value: 'QUEUED', label: 'Queued' },
            { value: 'SENT', label: 'Sent' },
          ]}
        />
      </Field>
      <DataTable
        caption="Notifications"
        columns={columns}
        rows={query.data?.items}
        getRowId={(n) => n.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'bell', title: status === 'DEAD' || status === 'FAILED' ? 'No failed notifications' : 'No notifications in this state' }}
        rowActions={(n) =>
          (n.status === 'DEAD' || n.status === 'FAILED') && (canOps || canSupport) ? (
            n.template === 'otp' ? (
              <Badge>One-time codes can't be retried</Badge>
            ) : (
              <Button size="sm" variant="secondary" icon="refresh" loading={retry.isPending && retry.variables === n.id} onClick={() => retry.mutate(n.id)}>
                Retry send
              </Button>
            )
          ) : null
        }
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
    </div>
  );
}
