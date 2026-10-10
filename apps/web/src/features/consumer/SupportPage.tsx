/**
 * Support (PRD C-14): raise a ticket (optionally against an order / one restaurant's part of it) and read /
 * reply to the ticket thread. `/support?checkoutId=&childOrderId=` pre-fills the order link from order pages.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  Field,
  FormActions,
  InlineError,
  Input,
  PageHeader,
  QueryState,
  Select,
  SkeletonList,
  StatusPill,
  Textarea,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { api } from '../../lib/api';
import { fieldErrors } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import { fetchTicket, fetchTickets, type SupportTicket, type TicketCategory } from './api';

const CATEGORIES: { value: TicketCategory; label: string }[] = [
  { value: 'ORDER_ISSUE', label: 'Problem with an order' },
  { value: 'PAYMENT', label: 'Payment or refund' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'ACCOUNT', label: 'Account' },
  { value: 'OTHER', label: 'Something else' },
];
const TICKETS_KEY = ['support', 'tickets'] as const;

function NewTicketForm() {
  const [params] = useSearchParams();
  const checkoutId = params.get('checkoutId');
  const childOrderId = params.get('childOrderId');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>(checkoutId ? 'ORDER_ISSUE' : 'OTHER');
  const [message, setMessage] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>('/support/tickets', {
        method: 'POST',
        body: {
          subject: subject.trim(),
          category,
          message: message.trim(),
          ...(checkoutId ? { checkoutGroupId: checkoutId } : {}),
          ...(childOrderId ? { childOrderId } : {}),
        },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: TICKETS_KEY });
      const t = (res.ticket ?? res) as SupportTicket;
      if (t?.id) navigate(`/support/${t.id}`);
      else {
        setSubject('');
        setMessage('');
      }
    },
  });
  const errs = { ...fieldErrors(create.error), ...local };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const l: Record<string, string> = {};
    if (subject.trim().length < 3) l.subject = 'Add a short subject';
    if (message.trim().length < 5) l.message = 'Tell us what happened';
    setLocal(l);
    if (!Object.keys(l).length) create.mutate();
  };
  return (
    <Card as="section" aria-label="New support ticket">
      <CardHeader title="Raise a ticket" description={checkoutId ? 'Linked to your order — we can see its details.' : 'We usually reply within a few hours.'} />
      {checkoutId ? (
        <p className="mb-3 text-sm text-slate-700">
          Order: <Link className="font-medium text-brand-700 underline" to={`/orders/${checkoutId}`}>view order</Link>
          {childOrderId ? ' (one restaurant’s part)' : ''}
        </p>
      ) : null}
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Topic" required>
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)} options={CATEGORIES} />
        </Field>
        <Field label="Subject" required error={errs.subject}>
          <Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What happened?" required error={errs.message ?? errs.body}>
          <Textarea value={message} rows={4} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <InlineError error={create.error && !Object.keys(fieldErrors(create.error)).length ? create.error : null} />
        <FormActions>
          <Button type="submit" loading={create.isPending}>
            Send
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

function TicketList() {
  const q = useQuery({ queryKey: TICKETS_KEY, queryFn: fetchTickets });
  return (
    <Card as="section" aria-label="Your tickets">
      <CardHeader title="Your tickets" />
      <QueryState query={q} loading={<SkeletonList count={2} />} isEmpty={(l) => l.length === 0} empty={{ icon: 'ticket', title: 'No tickets yet', description: 'Raised tickets and replies appear here.', compact: true }}>
        {(list) => (
          <ul className="divide-y divide-slate-100">
            {list.map((t) => (
              <li key={t.id}>
                <Link to={`/support/${t.id}`} className="flex min-h-touch items-center justify-between gap-2 py-2 hover:bg-slate-50">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{t.subject}</span>
                    <span className="block text-xs text-slate-600">
                      {t.code ? `${t.code} · ` : ''}
                      {t.updatedAt ?? t.createdAt ? formatDateTime((t.updatedAt ?? t.createdAt)!) : ''}
                    </span>
                  </span>
                  <StatusPill kind="ticket" status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

export default function SupportPage() {
  return (
    <>
      <PageHeader title="Help & support" back={{ to: '/account', label: 'Account' }} />
      <RequireAuth signInMessage="Sign in to contact support about your orders.">
        <div className="grid gap-6 lg:grid-cols-2">
          <NewTicketForm />
          <TicketList />
        </div>
      </RequireAuth>
    </>
  );
}

function TicketThread({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => fetchTicket(id), refetchInterval: 30_000 });
  const [reply, setReply] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/support/tickets/${id}/messages`, { method: 'POST', body: { body: reply.trim() } }),
    onSuccess: () => {
      setReply('');
      void qc.invalidateQueries({ queryKey: ['support', 'ticket', id] });
      void qc.invalidateQueries({ queryKey: TICKETS_KEY });
    },
  });
  return (
    <QueryState query={q} loading={<SkeletonList count={3} />}>
      {(t) => (
        <>
          <PageHeader title={t.subject} back={{ to: '/support', label: 'Support' }} status={<StatusPill kind="ticket" status={t.status} />} description={t.code} />
          {t.checkoutGroupId ? (
            <p className="mb-3 text-sm">
              <Link className="text-brand-700 underline" to={`/orders/${t.checkoutGroupId}`}>
                View the linked order
              </Link>
            </p>
          ) : null}
          <ol className="mb-4 space-y-3" aria-label="Messages">
            {(t.messages ?? []).map((m, i) => {
              const mine = m.authorRole === 'CONSUMER' || m.authorRole === 'CUSTOMER';
              return (
                <li key={`${m.at}-${i}`} className={cn('max-w-[85%] rounded-card px-3 py-2 text-sm', mine ? 'ml-auto bg-brand-50 text-slate-900' : 'bg-surface-muted text-slate-900')}>
                  <p className="mb-1 text-xs font-semibold text-slate-600">
                    {mine ? 'You' : 'Thali support'} · {formatDateTime(m.at)}
                  </p>
                  <p className="whitespace-pre-line">{m.body}</p>
                </li>
              );
            })}
          </ol>
          {t.status === 'CLOSED' ? (
            <p className="text-sm text-slate-600">This ticket is closed. Raise a new one if you still need help.</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (reply.trim()) send.mutate();
              }}
              className="space-y-2"
            >
              <Field label="Reply">
                <Textarea value={reply} rows={3} maxLength={2000} onChange={(e) => setReply(e.target.value)} />
              </Field>
              <InlineError error={send.error} />
              <FormActions>
                <Button type="submit" loading={send.isPending} disabled={!reply.trim()}>
                  Send reply
                </Button>
              </FormActions>
            </form>
          )}
        </>
      )}
    </QueryState>
  );
}

export function TicketPage() {
  const { ticketId = '' } = useParams();
  return (
    <RequireAuth signInMessage="Sign in to see this ticket.">
      <TicketThread id={ticketId} />
    </RequireAuth>
  );
}
