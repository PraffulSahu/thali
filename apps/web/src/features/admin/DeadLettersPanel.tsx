/**
 * Events that failed every retry in some service, gathered by the notifications service.
 * "Replay all" = NTF-3 `POST /admin/notifications/dead-letters/replay` (oldest first, ≤100); per-row replay stays.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { InfoNotice } from '../../components/ui/Notice';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { plural } from '../../lib/format';
import { listDeadLetters, qk, replayDeadLetter, type DeadLetter } from './api';
import { useReplayAllDeadLetters } from './bulk';
import { Mono, useAdminMutation, useAdminRoles } from './shared';
import { RoleNote } from './ui';

const eventType = (d: DeadLetter) => {
  const e = d.envelope as { type?: unknown } | null;
  return e && typeof e.type === 'string' ? e.type : d.stream;
};

export default function DeadLettersPanel({ titleId }: { titleId?: string }) {
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.deadLetters, queryFn: listDeadLetters });
  const [replaying, setReplaying] = useState<DeadLetter | null>(null);
  const [all, setAll] = useState(false);
  const replay = useAdminMutation((d: DeadLetter) => replayDeadLetter(d.service, d.id), {
    success: 'Event re-queued for processing',
    invalidate: [qk.deadLetters as unknown as unknown[], ['admin', 'health']],
  });
  const replayAll = useReplayAllDeadLetters();

  const pending = (query.data?.items ?? []).filter((d) => !d.replayedAt);
  const columns: Column<DeadLetter>[] = [
    { key: 'type', header: 'Event', cell: (d) => <Mono>{eventType(d)}</Mono>, primary: true },
    { key: 'service', header: 'Service', cell: (d) => d.service, secondary: true },
    { key: 'error', header: 'Last error', cell: (d) => <span className="block max-w-md whitespace-normal break-words font-mono text-[12px] text-bad">{d.error}</span> },
    { key: 'attempts', header: 'Attempts', cell: (d) => d.attempts, align: 'right', hideOnMobile: true },
    { key: 'failed', header: 'Failed', cell: (d) => <RelativeTime value={d.failedAt} className="text-fg-3" />, hideOnMobile: true },
    { key: 'replays', header: 'Replays', cell: (d) => d.replayCount, align: 'right', hideOnMobile: true },
  ];

  const errors = query.data?.errors ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-[17px] text-fg">
          Dead-lettered events
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {!canOps ? <RoleNote>Replaying needs the Ops role</RoleNote> : null}
          <Button variant="outline" size="sm" icon="refresh" disabled={!canOps || pending.length === 0} loading={replayAll.isPending} onClick={() => setAll(true)}>
            Replay all{pending.length ? ` (${pending.length})` : ''}
          </Button>
        </div>
      </div>
      {errors.length ? (
        <InfoNotice tone="warn" icon="alert" role="alert">
          <p className="font-medium text-fg">Some services could not be checked for dead letters, so this list may be incomplete:</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e.service}>
                <strong>{e.service}</strong>: {e.message} <Mono>{e.code}</Mono>
              </li>
            ))}
          </ul>
        </InfoNotice>
      ) : null}
      <DataTable
        caption="Dead-lettered events"
        columns={columns}
        rows={query.data?.items}
        getRowId={(d) => `${d.service}:${d.id}`}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{
          icon: 'check',
          title: errors.length ? 'No dead letters found in the services that answered' : 'No dead-lettered events',
          description: query.data?.sources.length ? `Checked: ${query.data.sources.join(', ')}.` : undefined,
        }}
        rowActions={(d) =>
          canOps && !d.replayedAt ? (
            <Button size="xs" variant="outline" icon="refresh" onClick={() => setReplaying(d)}>
              Replay
            </Button>
          ) : d.replayedAt ? (
            <span className="text-[12px] text-fg-3">Replayed</span>
          ) : null
        }
      />
      <ConfirmDialog
        open={replaying !== null}
        onClose={() => setReplaying(null)}
        title="Replay this event?"
        description={replaying ? `${eventType(replaying)} in ${replaying.service} will be processed again. Handlers are idempotent, so a replay is safe, and it is recorded in the audit log.` : undefined}
        confirmLabel="Replay event"
        onConfirm={() => replay.mutateAsync(replaying!)}
      />
      <ConfirmDialog
        open={all}
        onClose={() => setAll(false)}
        title={`Replay ${plural(pending.length, 'dead letter')}?`}
        description="Every unreplayed dead-lettered event (up to 100, oldest first) is processed again across all services. Recorded in the audit log."
        confirmLabel="Replay all"
        onConfirm={() => replayAll.mutateAsync()}
      />
    </>
  );
}
