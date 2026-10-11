/**
 * `/admin/health`: live application health, exactly as GW-1 `GET /admin/health` reports it. The gateway probes every
 * service on each request: `down` = unreachable (real error text), `degraded` = reachable with reasons (a failing
 * provider is Degraded, never Down). Then NTF-1 notification counts + last provider error, dead letters (NTF-3 bulk
 * replay + per item), failed notifications (NTF-2 bulk retry + per item) and the demo-only provider fail-mode.
 * Never a decorative "all good": every row comes from the probe.
 */
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { KpiStrip, KpiTile } from '../../components/ui/KpiTile';
import { StatusBanner } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { formatDuration, formatRelative } from '../../lib/format';
import { notificationSummary, qk, type HealthReport, type HealthState, type ServiceHealth } from './api';
import DeadLettersPanel from './DeadLettersPanel';
import NotificationsPanel from './NotificationsPanel';
import { Mono } from './shared';
import { useHealth } from './shell';
import { agoLabel, HEALTH_TEXT_TONE, serviceHealthText, useNow } from './ui';

const REFRESH_MS = 30_000;
const OVERALL: Record<HealthState, { tone: 'ok' | 'warn' | 'bad'; title: string }> = {
  up: { tone: 'ok', title: 'Every service answered and passed its checks' },
  degraded: { tone: 'warn', title: 'Some services need attention' },
  down: { tone: 'bad', title: 'No service is answering' },
};

const orUnknown = (v: number | null | undefined, fmt: (n: number) => string = String) => (v === null || v === undefined ? 'unknown' : fmt(v));

function Detail({ label, children, bad }: { label: string; children: React.ReactNode; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[12.5px] text-fg-3">{label}</dt>
      <dd className={`text-right font-mono text-[12px] ${bad ? 'text-bad' : 'text-fg'}`}>{children}</dd>
    </div>
  );
}

function ServiceDetails({ health }: { health: ServiceHealth }) {
  const d = health.details;
  const lag = Object.entries(d?.consumerLag ?? {});
  const byProvider = Object.entries(d?.providerErrorsByProvider ?? {});
  return (
    <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
      <Detail label="Mongo" bad={d?.mongo === 'down'}>{d?.mongo ?? 'unknown'}</Detail>
      <Detail label="Redis" bad={d?.redis === 'down'}>{d?.redis ?? 'unknown'}</Detail>
      <Detail label="Outbox waiting" bad={(d?.outboxOldestAgeSec ?? 0) > 60}>{orUnknown(d?.outboxPending)}</Detail>
      <Detail label="Oldest waiting">{d?.outboxOldestAgeSec == null ? 'none' : formatDuration(d.outboxOldestAgeSec)}</Detail>
      <Detail label="Stream backlog" bad={lag.some(([, n]) => (n ?? 0) > 100)}>
        {lag.length ? lag.map(([s, n]) => `${s}: ${orUnknown(n)}`).join(' · ') : 'none reported'}
      </Detail>
      <Detail label="Dead letters" bad={(d?.deadLetters ?? 0) > 0}>{orUnknown(d?.deadLetters)}</Detail>
      <Detail label="Provider errors, last hour" bad={(d?.providerErrorsLastHour ?? 0) > 0}>
        {orUnknown(d?.providerErrorsLastHour)}
        {byProvider.length ? ` (${byProvider.map(([p, n]) => `${p}: ${n}`).join(', ')})` : ''}
      </Detail>
      <Detail label="Mode">{typeof d?.mode === 'string' ? d.mode : 'unknown'}</Detail>
    </dl>
  );
}


function ServiceRow({ name, health }: { name: string; health: ServiceHealth }) {
  const [open, setOpen] = useState(health.status !== 'up');
  const text = serviceHealthText(health);
  const failing = Object.entries(health.providers ?? {}).filter(([, s]) => s === 'failing');
  const providers = Object.entries(health.providers ?? {});
  return (
    <Fragment>
      <tr aria-label={`${humanize(name)} service`} data-status={health.status} className="border-b border-line align-top">
        <th scope="row" className="whitespace-nowrap px-3.5 py-3 text-left text-[13.5px] font-medium text-fg">
          {name}
        </th>
        <td className="px-3.5 py-3">
          <StatusPill kind="health" status={health.status} density="dense" />
        </td>
        <td className="min-w-[240px] px-3.5 py-3">
          <p className={`break-words font-mono text-[12px] ${HEALTH_TEXT_TONE[health.status]}`}>{text}</p>
          {health.status === 'down' && health.errorCode ? <p className="mt-1 text-[12px] text-fg-3">Error code <Mono>{health.errorCode}</Mono></p> : null}
          {providers.length ? (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {providers.map(([p, s]) => (
                <Badge key={p} tone={s === 'failing' ? 'warn' : 'neu'} density="dense">
                  {p} {s === 'failing' ? 'failing' : 'up'}
                </Badge>
              ))}
            </p>
          ) : null}
          {failing.length && health.status !== 'down' ? <span className="sr-only">Provider failures make a service degraded, not down.</span> : null}
        </td>
        <td className="whitespace-nowrap px-3.5 py-3 text-right font-mono text-[12px] text-fg-3">{health.latencyMs} ms</td>
        <td className="px-3.5 py-2 text-right">
          {health.details ? (
            <Button size="xs" variant="ghost" iconRight={open ? 'chevron-up' : 'chevron-down'} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              Details
            </Button>
          ) : null}
        </td>
      </tr>
      {open && health.details ? (
        <tr className="border-b border-line bg-bg-2">
          <td colSpan={5} className="px-3.5 py-2.5">
            <ServiceDetails health={health} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function HealthTable({ report }: { report: HealthReport }) {
  const rank = { down: 0, degraded: 1, up: 2 } as const;
  const services = Object.entries(report.services).sort((a, b) => rank[a[1].status] - rank[b[1].status] || a[0].localeCompare(b[0]));
  return (
    <section aria-label="Services" className="overflow-hidden rounded-field border border-line bg-card">
      <header className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <h2 className="text-[14.5px] text-fg">System health</h2>
        <span className="text-xs text-fg-3">{Object.keys(report.services).length + 1} components</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">Per-service health</caption>
          <tbody>
            {services.map(([name, s]) => (
              <ServiceRow key={name} name={name} health={s} />
            ))}
            <tr aria-label="Gateway" data-status={report.gateway.status} className="align-top">
              <th scope="row" className="px-3.5 py-3 text-left text-[13.5px] font-medium text-fg">gateway</th>
              <td className="px-3.5 py-3">
                <StatusPill kind="health" status={report.gateway.status} density="dense" />
              </td>
              <td className="px-3.5 py-3 font-mono text-[12px]">
                <span className={report.gateway.redis === 'down' ? 'text-bad' : 'text-fg-3'}>redis {report.gateway.redis}</span>
                <span className="text-fg-3"> · mode {report.gateway.mode}</span>
              </td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NotificationCounts() {
  const q = useQuery({ queryKey: qk.notificationSummary, queryFn: notificationSummary, refetchInterval: REFRESH_MS });
  const s = q.data;
  const unavailable = q.isError;
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip label="Notification delivery">
        <KpiTile label="Failed, retrying" loading={q.isPending} unavailable={unavailable} onRetry={() => void q.refetch()} value={s?.byStatus.FAILED} sub="All time" />
        <KpiTile label="Gave up" loading={q.isPending} unavailable={unavailable} onRetry={() => void q.refetch()} value={s ? <span className={s.byStatus.DEAD ? 'text-bad' : undefined}>{s.byStatus.DEAD}</span> : undefined} sub="All time" />
        <KpiTile
          label="Failed, last 24 h"
          loading={q.isPending}
          unavailable={unavailable}
          onRetry={() => void q.refetch()}
          value={s?.failedLast24h}
          sub={s ? `SMS ${s.byChannel.SMS.failed} · email ${s.byChannel.EMAIL.failed}` : undefined}
        />
        <KpiTile label="Queued" loading={q.isPending} unavailable={unavailable} onRetry={() => void q.refetch()} value={s?.byStatus.QUEUED} sub={s ? `${s.byStatus.SENT + s.byStatus.DELIVERED} sent` : undefined} />
      </KpiStrip>
      {s?.lastError ? (
        <p className="rounded-field border border-line bg-card px-4 py-3 text-[13px] text-fg-2">
          <span className="lbl mr-2 text-[11px]!">Last provider error</span>
          <span className="font-mono text-[12px] text-bad">{s.lastError.message}</span>
          <span className="text-fg-3">
            {' '}
            · {s.lastError.channel.toLowerCase()}
            {s.lastError.provider ? ` via ${s.lastError.provider}` : ''} · {formatRelative(s.lastError.at)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export default function HealthPage() {
  const query = useHealth(REFRESH_MS);
  const now = useNow();
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView?.({ block: 'start' });
  }, [hash, query.isSuccess]);

  return (
    <>
      <PageHeader
        title="Application health"
        meta={query.data ? <span>Last checked {agoLabel(query.data.checkedAt, now)} · measured live on every check</span> : <span>Measured live on every check</span>}
        actions={
          <Button variant="outline" icon="refresh" loading={query.isFetching} onClick={() => void query.refetch()}>
            Refresh
          </Button>
        }
      />
      <div className="flex flex-col gap-[18px]">
        <QueryState
          query={query}
          errorTitle="Couldn't check application health"
          loading={
            <div className="flex flex-col gap-2.5 rounded-field border border-line bg-card p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          }
          loadingLabel="Checking every service…"
        >
          {(report) => {
            const problems = Object.entries(report.services).filter(([, s]) => s.status !== 'up');
            const o = OVERALL[report.overall];
            return (
              <div className="flex flex-col gap-[18px]">
                <StatusBanner tone={o.tone} title={`Overall: ${humanize(report.overall === 'up' ? 'Up' : report.overall)} — ${o.title}`}>
                  {problems.length ? problems.map(([n, s]) => `${n} ${s.status}`).join(' · ') : `${Object.keys(report.services).length} services and the gateway answered.`}
                </StatusBanner>
                <HealthTable report={report} />
              </div>
            );
          }}
        </QueryState>

        <section aria-labelledby="ntf-title" className="flex flex-col gap-3">
          <h2 id="ntf-title" className="text-[17px] text-fg">
            Notification delivery
          </h2>
          <NotificationCounts />
        </section>

        <section id="dead-letters" aria-labelledby="dlq-title" className="flex scroll-mt-6 flex-col gap-3">
          <DeadLettersPanel titleId="dlq-title" />
        </section>
        <section id="failed-notifications" aria-labelledby="notif-title" className="flex scroll-mt-6 flex-col gap-3">
          <NotificationsPanel titleId="notif-title" />
        </section>
      </div>
    </>
  );
}
