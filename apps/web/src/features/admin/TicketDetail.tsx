/** `/admin/support/:id`: conversation thread, assign to me, reply, status (start / resolve / close / reopen). */
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Textarea } from '../../components/ui/Input';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../lib/format';
import { getTicket, patchTicket, qk, replyTicket, type Ticket } from './api';
import { KeyValues, Mono, useAdminMutation, useAdminRoles } from './shared';
import { DetailColumns, RoleNote } from './ui';

export default function TicketDetail() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const { canSupport } = useAdminRoles();
  const [body, setBody] = useState('');
  const query = useQuery({ queryKey: qk.ticket(id), queryFn: () => getTicket(id) });
  const invalidate = [qk.ticket(id) as unknown as unknown[], ['admin', 'tickets'], ['admin', 'overview', 'orders']];
  const reply = useAdminMutation((text: string) => replyTicket(id, text), { success: 'Reply sent', invalidate, onSuccess: () => setBody('') });
  const patch = useAdminMutation((v: Parameters<typeof patchTicket>[1]) => patchTicket(id, v), { success: 'Ticket updated', invalidate });

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim()) reply.mutate(body.trim());
  };

  return (
    <QueryState query={query}>
      {(t: Ticket) => {
        const closed = t.status === 'CLOSED';
        const mine = Boolean(auth.user?.id) && t.assigneeId === auth.user?.id;
        return (
          <>
            <PageHeader
              title={t.subject}
              documentTitle={`Ticket ${t.code}`}
              back={{ to: '/admin/support', label: 'All tickets' }}
              status={<StatusPill kind="ticket" status={t.status} />}
              meta={<span className="font-mono">{t.code}</span>}
            />
            <DetailColumns
              main={
                <SectionCard title="Conversation" count={t.messages?.length ?? 0}>
                  {t.messages?.length ? (
                    <ol aria-label="Conversation" className="flex flex-col gap-3 px-4 py-4">
                      {t.messages.map((m, i) => {
                        const staff = m.authorRole.startsWith('ADMIN');
                        return (
                          <li
                            key={i}
                            className={cn(
                              'max-w-[85%] rounded-card px-4 py-3',
                              staff ? 'self-end bg-acc-soft' : 'self-start border border-line bg-card',
                            )}
                          >
                            <p className="text-[12px] text-fg-3">
                              {staff ? 'Support' : 'Customer'} · {formatDateTime(m.at)}
                            </p>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-[14px] text-fg">{m.body}</p>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="px-4 py-4 text-[13.5px] text-fg-3">No messages yet.</p>
                  )}
                  <div className="border-t border-line bg-bg-2 px-4 py-3.5">
                    {canSupport && !closed ? (
                      <form onSubmit={send} className="flex flex-col gap-3">
                        <Field label="Reply to customer" hint="The customer is notified">
                          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={2000} />
                        </Field>
                        <div>
                          <Button type="submit" loading={reply.isPending} disabled={!body.trim()}>
                            Send reply
                          </Button>
                        </div>
                      </form>
                    ) : closed ? (
                      <p className="text-[13px] text-fg-3">This ticket is closed. Reopen it to reply.</p>
                    ) : (
                      <RoleNote>Your admin role can read tickets but not reply. Ask a Support or Ops admin.</RoleNote>
                    )}
                  </div>
                </SectionCard>
              }
              aside={
                <>
                  <SectionCard title="Ticket" bodyClassName="px-4 py-4">
                    <KeyValues
                      items={[
                        { label: 'Category', value: humanize(t.category) },
                        { label: 'Priority', value: t.priority ? humanize(t.priority) : '—' },
                        { label: 'Opened', value: formatDateTime(t.createdAt) },
                        { label: 'Assigned to', value: t.assigneeId ? mine ? <Badge tone="acc" density="dense">You</Badge> : <Mono>{t.assigneeId}</Mono> : 'Unassigned' },
                        { label: 'Customer', value: t.userId ? <Link className="underline underline-offset-2" to={`/admin/users?q=${encodeURIComponent(t.userId)}`}><Mono>{t.userId}</Mono></Link> : '—' },
                        {
                          label: 'Related order',
                          value: t.checkoutGroupId ? (
                            <Link className="text-acc-fg underline underline-offset-4" to={`/admin/orders/${t.checkoutGroupId}`}>
                              Open order
                            </Link>
                          ) : (
                            '—'
                          ),
                        },
                      ]}
                    />
                  </SectionCard>
                  <SectionCard title="Actions" bodyClassName="flex flex-wrap gap-2 px-4 py-4">
                    {canSupport ? (
                      <>
                        {!mine && !closed ? (
                          <Button size="sm" variant="outline" loading={patch.isPending && patch.variables?.assigneeId !== undefined} onClick={() => patch.mutate({ assigneeId: auth.user?.id ?? null })}>
                            Assign to me
                          </Button>
                        ) : null}
                        {t.status === 'OPEN' ? (
                          <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: 'IN_PROGRESS' })}>
                            Start working
                          </Button>
                        ) : null}
                        {t.status === 'OPEN' || t.status === 'IN_PROGRESS' ? (
                          <Button size="sm" onClick={() => patch.mutate({ status: 'RESOLVED' })}>
                            Mark resolved
                          </Button>
                        ) : null}
                        {t.status === 'RESOLVED' ? (
                          <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: 'CLOSED' })}>
                            Close ticket
                          </Button>
                        ) : null}
                        {t.status === 'RESOLVED' || closed ? (
                          <Button size="sm" variant="ghost" onClick={() => patch.mutate({ status: 'OPEN' })}>
                            Reopen
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <RoleNote>Changing tickets needs the Support or Ops role.</RoleNote>
                    )}
                  </SectionCard>
                </>
              }
            />
          </>
        );
      }}
    </QueryState>
  );
}
