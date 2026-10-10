/** `/admin/support/:id`: conversation, assign to me, reply, resolve/close/reopen. UNVERIFIED API shape. */
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Textarea } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { getTicket, patchTicket, qk, replyTicket, type Ticket } from './api';
import { KeyValues, Mono, SectionTitle, useAdminMutation, useAdminRoles } from './shared';

export default function TicketDetail() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const { canSupport } = useAdminRoles();
  const [body, setBody] = useState('');
  const query = useQuery({ queryKey: qk.ticket(id), queryFn: () => getTicket(id) });
  const invalidate = [qk.ticket(id) as unknown as unknown[], ['admin', 'tickets']];
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
            <PageHeader title={t.subject} documentTitle={`Ticket ${t.code}`} back={{ to: '/admin/support', label: 'All tickets' }} status={<StatusPill kind="ticket" status={t.status} />} description={t.code} />
            <div className="flex flex-col gap-6">
              <Card>
                <KeyValues
                  items={[
                    { label: 'Category', value: humanize(t.category) },
                    { label: 'Priority', value: t.priority ? humanize(t.priority) : '-' },
                    { label: 'Opened', value: formatDateTime(t.createdAt) },
                    { label: 'Assigned to', value: t.assigneeId ? (mine ? <Badge tone="brand">You</Badge> : <Mono>{t.assigneeId}</Mono>) : 'Unassigned' },
                    { label: 'Customer', value: t.userId ? <Mono>{t.userId}</Mono> : '-' },
                    { label: 'Related order', value: t.checkoutGroupId ? <Link className="text-brand-700 underline underline-offset-4" to={`/admin/orders/${t.checkoutGroupId}`}>Open order</Link> : '-' },
                  ]}
                />
                {canSupport ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!mine && !closed ? <Button variant="secondary" loading={patch.isPending} onClick={() => patch.mutate({ assigneeId: auth.user?.id ?? null })}>Assign to me</Button> : null}
                    {t.status === 'OPEN' ? <Button variant="secondary" onClick={() => patch.mutate({ status: 'IN_PROGRESS' })}>Start working</Button> : null}
                    {t.status === 'OPEN' || t.status === 'IN_PROGRESS' ? <Button onClick={() => patch.mutate({ status: 'RESOLVED' })}>Mark resolved</Button> : null}
                    {t.status === 'RESOLVED' ? <Button variant="secondary" onClick={() => patch.mutate({ status: 'CLOSED' })}>Close ticket</Button> : null}
                    {t.status === 'RESOLVED' || closed ? <Button variant="ghost" onClick={() => patch.mutate({ status: 'OPEN' })}>Reopen</Button> : null}
                  </div>
                ) : null}
              </Card>

              <Card>
                <SectionTitle>Conversation</SectionTitle>
                {t.messages?.length ? (
                  <ol aria-label="Conversation" className="flex flex-col gap-3">
                    {t.messages.map((m, i) => {
                      const staff = m.authorRole.startsWith('ADMIN');
                      return (
                        <li key={i} className={`max-w-[85%] rounded-card px-4 py-3 ${staff ? 'self-end bg-brand-50' : 'self-start bg-surface-muted'}`}>
                          <p className="text-sm text-slate-600">{staff ? 'Support' : 'Customer'} · {formatDateTime(m.at)}</p>
                          <p className="whitespace-pre-wrap break-words text-[0.9375rem] text-slate-900">{m.body}</p>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="text-sm text-slate-600">No messages yet.</p>
                )}
                {canSupport && !closed ? (
                  <form onSubmit={send} className="mt-4 flex flex-col gap-3">
                    <Field label="Reply to customer" hint="The customer is notified">
                      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={2000} />
                    </Field>
                    <div>
                      <Button type="submit" loading={reply.isPending} disabled={!body.trim()}>Send reply</Button>
                    </div>
                  </form>
                ) : closed ? (
                  <p className="mt-4 text-sm text-slate-600">This ticket is closed. Reopen it to reply.</p>
                ) : (
                  <p className="mt-4 text-sm text-slate-600">Your admin role can read tickets but not reply.</p>
                )}
              </Card>
            </div>
          </>
        );
      }}
    </QueryState>
  );
}
