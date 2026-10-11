/** `/admin/audit`: every privileged action (who, what, target, IP, correlation id) with filters. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Select } from '../../components/ui/Select';
import { formatDateTime } from '../../lib/format';
import { istDateToIso, listAuditLogs, qk, type AuditLog } from './api';
import { FilterBar, Mono } from './shared';

/** Target ids that have an admin page become links (design-spec §7.5 "target link"). */
function TargetLink({ type, id }: { type: string; id: string }) {
  const to =
    type === 'restaurant' ? `/admin/restaurants/${id}` : type === 'partner' || type === 'delivery_partner' ? `/admin/partners/${id}` : type === 'checkout' || type === 'checkout_group' ? `/admin/orders/${id}` : type === 'ticket' || type === 'support_ticket' ? `/admin/support/${id}` : type === 'user' ? `/admin/users?q=${encodeURIComponent(id)}` : null;
  return to ? (
    <Link to={to} className="relative z-[1] underline underline-offset-2 hover:text-acc-fg">
      <Mono className="text-[11.5px]">{id}</Mono>
    </Link>
  ) : (
    <Mono className="text-[11.5px]">{id}</Mono>
  );
}

type Filters = { action: string; service: string; actorId: string; targetType: string; targetId: string; from: string; to: string };
const EMPTY: Filters = { action: '', service: '', actorId: '', targetType: '', targetId: '', from: '', to: '' };
const SERVICES = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications'];

export default function AuditLogPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const pages = useCursorPages();
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const query = useQuery({
    queryKey: qk.audit({ ...applied, cursor: pages.cursor }),
    queryFn: () =>
      listAuditLogs({
        action: applied.action.trim() || undefined,
        service: applied.service || undefined,
        actorId: applied.actorId.trim() || undefined,
        targetType: applied.targetType.trim() || undefined,
        targetId: applied.targetId.trim() || undefined,
        from: istDateToIso(applied.from, 'start'),
        to: istDateToIso(applied.to, 'end'),
        cursor: pages.cursor,
      }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<AuditLog>[] = [
    { key: 'summary', header: 'What happened', cell: (l) => l.summary, primary: true },
    { key: 'action', header: 'Action', cell: (l) => <Badge density="dense" className="font-mono">{l.action}</Badge>, secondary: true },
    { key: 'actor', header: 'Actor', cell: (l) => <span><span className="block text-[12.5px] text-fg-2">{l.actorRole}</span><Mono className="text-[11.5px]">{l.actorId}</Mono></span> },
    { key: 'target', header: 'Target', cell: (l) => <span><span className="block text-[12.5px] text-fg-2">{l.targetType}</span><TargetLink type={l.targetType} id={l.targetId} /></span>, hideOnMobile: true },
    { key: 'ip', header: 'IP', cell: (l) => <Mono className="text-[11.5px]">{l.ip ?? '—'}</Mono>, hideOnMobile: true },
    { key: 'service', header: 'Service', cell: (l) => l.service, hideOnMobile: true },
    { key: 'when', header: 'When (IST)', cell: (l) => <span className="font-mono text-[12px] text-fg-3">{formatDateTime(l.occurredAt)}</span> },
    { key: 'corr', header: 'Correlation id', cell: (l) => <Mono>{l.correlationId}</Mono>, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Audit log" description="A permanent record of privileged actions across every service." />
      <FilterBar onSubmit={() => { pages.reset(); setApplied(draft); }}>
        <Field label="Action" hint="Exact, like restaurant.approve">
          <Input value={draft.action} onChange={set('action')} className="font-mono" />
        </Field>
        <Field label="Service">
          <Select value={draft.service} onChange={set('service')} placeholder="Any service" options={SERVICES.map((s) => ({ value: s, label: s }))} />
        </Field>
        <Field label="Actor id">
          <Input value={draft.actorId} onChange={set('actorId')} className="font-mono" />
        </Field>
        <Field label="Target type" hint="Like restaurant, payout">
          <Input value={draft.targetType} onChange={set('targetType')} />
        </Field>
        <Field label="Target id">
          <Input value={draft.targetId} onChange={set('targetId')} className="font-mono" />
        </Field>
        <Field label="From (IST)">
          <Input type="date" value={draft.from} onChange={set('from')} />
        </Field>
        <Field label="To (IST)">
          <Input type="date" value={draft.to} onChange={set('to')} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); pages.reset(); }}>Clear</Button>
        </div>
      </FilterBar>
      <DataTable
        caption="Audit log"
        columns={columns}
        rows={query.data?.items}
        getRowId={(l) => l.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'shield', title: 'No audit entries match', description: 'Widen the date range or clear a filter.' }}
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
    </>
  );
}
