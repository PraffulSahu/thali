/**
 * Support (design-spec §7.2; PRD C-14). `/support`: your tickets (chip, subject, last update) + "Raise a ticket"
 * (topic, optional order select from your recent orders, subject, message). `/support?new=1&orderId=<checkoutId>`
 * (tracking "Get help") opens the form pre-linked to that order; legacy `?checkoutId=&childOrderId=` still works.
 * `/support/:ticketId`: message thread (you: --acc-soft right; support: card left) + sticky reply box.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  FormActions,
  Icon,
  InlineError,
  Input,
  PageHeader,
  SectionCard,
  Select,
  SkeletonList,
  StatusPill,
  Textarea,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { fieldErrors } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import { createTicket, fetchOrders, fetchTicket, fetchTickets, replyTicket, type TicketCategory } from './api';
import { PageContainer } from './ConsumerLayout';

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
  const prefOrder = params.get('orderId') ?? params.get('checkoutId');
  const childOrderId = params.get('childOrderId');
  const focusNew = params.get('new') === '1';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const orders = useQuery({ queryKey: ['orders', 'recent-for-support'], queryFn: () => fetchOrders(null), staleTime: 60_000 });
  const [orderId, setOrderId] = useState(prefOrder ?? '');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>(prefOrder ? 'ORDER_ISSUE' : 'OTHER');
  const [message, setMessage] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const subjectRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusNew) subjectRef.current?.focus();
  }, [focusNew]);
  const recent = orders.data?.items ?? [];
  const linked = recent.find((o) => o.id === orderId);
  const create = useMutation({
    mutationFn: () =>
      createTicket({
        subject: subject.trim(),
        category,
        body: message.trim(),
        ...(orderId ? { checkoutGroupId: orderId } : {}),
        ...(childOrderId && orderId === prefOrder ? { childOrderId } : {}),
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: TICKETS_KEY });
      navigate(`/support/${t.id}`);
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
    <SectionCard title="Raise a ticket" meta={orderId ? 'Linked to your order — we can see its details.' : 'We usually reply within a few hours.'} bodyClassName="p-5" className={cn(focusNew && 'ring-2 ring-acc/40')}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Topic" required>
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)} options={CATEGORIES} />
        </Field>
        <Field label="Order" optional hint={linked ? undefined : prefOrder && !orders.isPending ? 'This order is linked to your ticket.' : undefined}>
          <Select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            options={[
              { value: '', label: 'Not about an order' },
              ...(prefOrder && !recent.some((o) => o.id === prefOrder) ? [{ value: prefOrder, label: 'The order you came from' }] : []),
              ...recent.map((o) => ({ value: o.id, label: `${o.code} · ${o.children.map((c) => c.restaurantName).join(', ')}` })),
            ]}
          />
        </Field>
        {orderId ? (
          <p className="-mt-2 text-[13px]">
            <Link className="font-medium text-acc-fg underline" to={`/orders/${orderId}`}>
              View order
            </Link>
            {childOrderId && orderId === prefOrder ? <span className="text-fg-3"> (one restaurant&rsquo;s part)</span> : null}
          </p>
        ) : null}
        <Field label="Subject" required error={errs.subject}>
          <Input ref={subjectRef} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What happened?" required error={errs.message ?? errs.body}>
          <Textarea value={message} rows={4} maxLength={5000} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <InlineError error={create.error && !Object.keys(fieldErrors(create.error)).length ? create.error : null} />
        <FormActions>
          <Button type="submit" loading={create.isPending}>
            Send
          </Button>
        </FormActions>
      </form>
    </SectionCard>
  );
}

function TicketList() {
  const q = useQuery({ queryKey: TICKETS_KEY, queryFn: fetchTickets });
  return (
    <SectionCard title="Your tickets" count={q.data?.length} bodyClassName="">
      {q.isPending ? (
        <div className="p-4">
          <SkeletonList count={2} />
        </div>
      ) : q.isError ? (
        <ErrorState compact error={q.error} title="Couldn't load your tickets" onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState compact icon="ticket" title="No tickets yet" description="Raised tickets and replies appear here." />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.map((t) => (
            <li key={t.id}>
              <Link to={`/support/${t.id}`} className="flex min-h-touch items-center gap-3 px-4 py-3 hover:bg-fill">
                <StatusPill kind="ticket" status={t.status} density="dense" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium">{t.subject}</span>
                  <span className="block text-[12.5px] text-fg-3">
                    {t.code ? <span className="font-mono">{t.code}</span> : null}
                    {t.code ? ' · ' : ''}
                    {(t.updatedAt ?? t.createdAt) ? `updated ${formatDateTime((t.updatedAt ?? t.createdAt)!)}` : ''}
                  </span>
                </span>
                <Icon name="chevron-right" size={16} className="text-fg-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export default function SupportPage() {
  return (
    <PageContainer>
      <PageHeader size="page" title="Help & support" description="Tell us what went wrong — tickets linked to an order show us every detail of it." />
      <RequireAuth signInMessage="Sign in to contact support about your orders.">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <NewTicketForm />
          <TicketList />
        </div>
      </RequireAuth>
    </PageContainer>
  );
}

function TicketThread({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => fetchTicket(id), refetchInterval: 30_000 });
  const [reply, setReply] = useState('');
  const send = useMutation({
    mutationFn: () => replyTicket(id, reply.trim()),
    onSuccess: () => {
      setReply('');
      void qc.invalidateQueries({ queryKey: ['support', 'ticket', id] });
      void qc.invalidateQueries({ queryKey: TICKETS_KEY });
    },
  });
  if (q.isPending) return <SkeletonList count={3} />;
  if (q.isError) return <ErrorState error={q.error} title="Couldn't load this ticket" onRetry={() => void q.refetch()} />;
  const t = q.data;
  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Breadcrumb" className="flex gap-1.5 text-[13px] text-fg-3">
        <Link to="/support" className="hover:text-fg">
          Support
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono">{t.code}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] leading-tight">{t.subject}</h1>
        <StatusPill kind="ticket" status={t.status} />
      </div>
      {t.checkoutGroupId ? (
        <p className="text-sm">
          <Link className="text-acc-fg underline" to={`/orders/${t.checkoutGroupId}`}>
            View the linked order
          </Link>
        </p>
      ) : null}
      <ol className="flex flex-col gap-3" aria-label="Messages">
        {(t.messages ?? []).map((m, i) => {
          const mine = m.authorRole === 'CUSTOMER';
          return (
            <li key={`${m.at}-${i}`} className={cn('max-w-[85%] rounded-card px-4 py-3 text-sm', mine ? 'ml-auto bg-acc-soft' : 'border border-line bg-card')}>
              <p className="mb-1 text-xs font-semibold text-fg-3">
                {mine ? 'You' : 'Thali support'}
                {m.at ? ` · ${formatDateTime(m.at)}` : ''}
              </p>
              <p className="whitespace-pre-line text-fg">{m.body}</p>
            </li>
          );
        })}
      </ol>
      {t.status === 'CLOSED' ? (
        <p className="text-sm text-fg-3">This ticket is closed. Raise a new one if you still need help.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) send.mutate();
          }}
          className="sticky bottom-0 flex flex-col gap-2 border-t border-line bg-bg/95 py-3 backdrop-blur max-sm:bottom-14"
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
    </div>
  );
}

export function TicketPage() {
  const { ticketId = '' } = useParams();
  return (
    <PageContainer width="narrow">
      <RequireAuth signInMessage="Sign in to see this ticket.">
        <TicketThread id={ticketId} />
      </RequireAuth>
    </PageContainer>
  );
}
