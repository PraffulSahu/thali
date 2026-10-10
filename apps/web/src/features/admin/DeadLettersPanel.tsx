/** Events that failed every retry in some service, gathered by the notifications service; replay one at a time. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { listDeadLetters, qk, replayDeadLetter, type DeadLetter } from './api';
import { Mono, useAdminMutation, useAdminRoles } from './shared';

const eventType = (d: DeadLetter) => {
  const e = d.envelope as { type?: unknown } | null;
  return e && typeof e.type === 'string' ? e.type : d.stream;
};

export default function DeadLettersPanel() {
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.deadLetters, queryFn: listDeadLetters });
  const [replaying, setReplaying] = useState<DeadLetter | null>(null);
  const replay = useAdminMutation((d: DeadLetter) => replayDeadLetter(d.service, d.id), {
    success: 'Event re-queued for processing',
    invalidate: [qk.deadLetters as unknown as unknown[], ['admin', 'health']],
  });

  const columns: Column<DeadLetter>[] = [
    { key: 'type', header: 'Event', cell: (d) => <Mono>{eventType(d)}</Mono>, primary: true },
    { key: 'service', header: 'Service', cell: (d) => d.service, secondary: true },
    { key: 'error', header: 'Last error', cell: (d) => <span className="break-words text-sm text-danger-700">{d.error}</span> },
    { key: 'attempts', header: 'Attempts', cell: (d) => d.attempts, align: 'right', hideOnMobile: true },
    { key: 'failed', header: 'Failed', cell: (d) => <RelativeTime value={d.failedAt} />, hideOnMobile: true },
    { key: 'replays', header: 'Replays', cell: (d) => d.replayCount, align: 'right', hideOnMobile: true },
  ];

  const errors = query.data?.errors ?? [];
  return (
    <div className="flex flex-col gap-3">
      {errors.length ? (
        <div role="alert" className="rounded-control border border-warn-100 bg-warn-50 px-4 py-3 text-sm text-warn-800">
          <p className="font-medium">Some services could not be checked for dead letters, so this list may be incomplete:</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e.service}>
                <strong>{e.service}</strong>: {e.message} <Badge tone="warn">{e.code}</Badge>
              </li>
            ))}
          </ul>
        </div>
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
          canOps ? (
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => setReplaying(d)}>
              Replay
            </Button>
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
    </div>
  );
}
