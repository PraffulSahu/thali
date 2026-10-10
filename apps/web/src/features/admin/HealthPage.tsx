/**
 * `/admin/health`: live application health, exactly as `GET /admin/health` reports it. The gateway probes
 * every service's `/internal/health/details` on each request; a service it cannot reach is shown `down` with
 * the error text, never a made-up "ok". Below: backlog / dead-letter replay and failed notification retry.
 */
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { formatDuration } from '../../lib/format';
import { getHealth, qk, type HealthReport, type HealthState, type ServiceHealth } from './api';
import DeadLettersPanel from './DeadLettersPanel';
import NotificationsPanel from './NotificationsPanel';
import { Mono, SectionTitle } from './shared';

const REFRESH_MS = 30_000;
const STATE_LABEL: Record<HealthState, string> = { up: 'Up', degraded: 'Degraded', down: 'Down' };
const CARD_TONE: Record<HealthState, string> = {
  up: 'border-slate-200 bg-surface',
  degraded: 'border-warn-100 bg-warn-50',
  down: 'border-danger-600 bg-danger-50',
};

function Row({ label, children, bad }: { label: string; children: React.ReactNode; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={`text-right text-sm font-medium tabular-nums ${bad ? 'text-danger-700' : 'text-slate-900'}`}>{children}</dd>
    </div>
  );
}

const orUnknown = (v: number | null | undefined, fmt: (n: number) => string = String) => (v === null || v === undefined ? 'unknown' : fmt(v));
const link = (v: 'up' | 'down' | undefined) => (v === undefined ? 'unknown' : v);

function ServiceCard({ name, health }: { name: string; health: ServiceHealth }) {
  const d = health.details;
  const lag = Object.entries(d?.consumerLag ?? {});
  const byProvider = Object.entries(d?.providerErrorsByProvider ?? {});
  const title = humanize(name);
  return (
    <article aria-label={`${title} service`} data-status={health.status} className={`flex flex-col gap-3 rounded-card border p-4 shadow-raised ${CARD_TONE[health.status]}`}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <StatusPill kind="health" status={health.status} label={STATE_LABEL[health.status]} />
      </header>
      {health.status === 'down' ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-danger-800">
          <p className="break-words font-medium">{health.error ?? 'No response from this service.'}</p>
          {health.errorCode ? (
            <p>
              Error code <Mono className="text-danger-800">{health.errorCode}</Mono>
            </p>
          ) : null}
          <p className="text-slate-700">No details are available while the service is unreachable. It answered in {health.latencyMs} ms before failing.</p>
        </div>
      ) : (
        <dl className="divide-y divide-slate-200/70">
          <Row label="Response time">{health.latencyMs} ms</Row>
          <Row label="Mongo" bad={d?.mongo === 'down'}>{link(d?.mongo)}</Row>
          <Row label="Redis" bad={d?.redis === 'down'}>{link(d?.redis)}</Row>
          <Row label="Outbox waiting" bad={(d?.outboxPending ?? 0) > 0 && (d?.outboxOldestAgeSec ?? 0) > 60}>{orUnknown(d?.outboxPending)}</Row>
          <Row label="Oldest waiting">{d?.outboxOldestAgeSec == null ? 'none' : formatDuration(d.outboxOldestAgeSec)}</Row>
          {lag.length ? (
            <Row label="Stream backlog">
              <span className="flex flex-col items-end">
                {lag.map(([stream, n]) => (
                  <span key={stream}>{stream}: {orUnknown(n)}</span>
                ))}
              </span>
            </Row>
          ) : (
            <Row label="Stream backlog">none reported</Row>
          )}
          <Row label="Dead letters" bad={(d?.deadLetters ?? 0) > 0}>{orUnknown(d?.deadLetters)}</Row>
          <Row label="Provider errors, last hour" bad={(d?.providerErrorsLastHour ?? 0) > 0}>
            <span className="flex flex-col items-end">
              <span>{orUnknown(d?.providerErrorsLastHour)}</span>
              {byProvider.map(([p, n]) => (
                <span key={p} className="text-slate-700">{p}: {n}</span>
              ))}
            </span>
          </Row>
        </dl>
      )}
    </article>
  );
}

function GatewayCard({ report }: { report: HealthReport }) {
  const g = report.gateway;
  return (
    <article aria-label="Gateway" data-status={g.status} className={`flex flex-col gap-3 rounded-card border p-4 shadow-raised ${CARD_TONE[g.status]}`}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">Gateway</h3>
        <StatusPill kind="health" status={g.status} label={STATE_LABEL[g.status]} />
      </header>
      <dl className="divide-y divide-slate-200/70">
        <Row label="Redis" bad={g.redis === 'down'}>{g.redis}</Row>
        <Row label="Mode">{g.mode}</Row>
      </dl>
    </article>
  );
}

export default function HealthPage() {
  const query = useQuery({ queryKey: qk.health, queryFn: getHealth, refetchInterval: REFRESH_MS });
  return (
    <>
      <PageHeader
        title="Application health"
        description="Measured live on every check: nothing here is cached or assumed."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {query.data ? <RelativeTime value={query.data.checkedAt} prefix="Last checked" className="text-sm text-slate-600" /> : null}
            <Button variant="secondary" icon="refresh" loading={query.isFetching} onClick={() => void query.refetch()}>
              Refresh
            </Button>
          </div>
        }
      />
      <QueryState query={query} errorTitle="Couldn't check application health" loadingLabel="Checking every service…">
        {(report) => (
          <>
            <p
              role="status"
              data-status={report.overall}
              className={`mb-4 flex flex-wrap items-center gap-2 rounded-control border px-4 py-3 text-[0.9375rem] font-medium ${
                report.overall === 'up' ? 'border-success-100 bg-success-50 text-success-800' : report.overall === 'degraded' ? 'border-warn-100 bg-warn-50 text-warn-800' : 'border-danger-100 bg-danger-50 text-danger-800'
              }`}
            >
              Overall: {STATE_LABEL[report.overall]}
              {report.overall !== 'up' ? (
                <span className="font-normal">
                  {' '}
                  ({Object.entries(report.services).filter(([, s]) => s.status !== 'up').map(([n, s]) => `${n} ${s.status}`).join(', ') || 'see the gateway'})
                </span>
              ) : null}
            </p>
            <section aria-label="Services" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <GatewayCard report={report} />
              {Object.entries(report.services).map(([name, s]) => (
                <ServiceCard key={name} name={name} health={s} />
              ))}
            </section>
          </>
        )}
      </QueryState>

      <div className="mt-10 flex flex-col gap-10">
        <section aria-labelledby="dlq-title">
          <SectionTitle>
            <span id="dlq-title">Dead-lettered events</span>
          </SectionTitle>
          <DeadLettersPanel />
        </section>
        <section aria-labelledby="notif-title">
          <SectionTitle>
            <span id="notif-title">Notifications that need attention</span>
          </SectionTitle>
          <NotificationsPanel />
        </section>
      </div>
    </>
  );
}
