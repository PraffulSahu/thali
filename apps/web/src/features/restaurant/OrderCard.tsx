/**
 * One order on the board (PRD R-5). Shows what to cook, the acceptance countdown, prep-time controls and the
 * pickup code the delivery partner must quote. Every action calls the orders API and reports failures inline.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge, Button, Card, ConfirmDialog, Countdown, Field, FoodMarker, Icon, InlineError, Price, RelativeTime, Select, StatusPill, useToast,
} from '../../components/ui';
import { formatPhone, formatTime, plural } from '../../lib/format';
import { cn } from '../../lib/cn';
import { PREP_TIME_OPTIONS, ordersApi, type OwnerOrder } from './api';
import { RejectDialog } from './RejectDialog';

export interface OrderCardProps {
  order: OwnerOrder;
  /** Arrived since the screen opened: highlighted until it is accepted or rejected. */
  isNew?: boolean;
  /** Default prep time offered in the accept dialog. */
  defaultPrepMinutes: number;
  /** Called after any successful change so the board refetches. */
  onChanged: () => void;
}

function prepOptions(current: number) {
  const mins = PREP_TIME_OPTIONS.includes(current) ? PREP_TIME_OPTIONS : [...PREP_TIME_OPTIONS, current].sort((a, b) => a - b);
  return mins.map((m) => ({ value: String(m), label: `${m} min` }));
}

export function OrderCard({ order, isNew, defaultPrepMinutes, onChanged }: OrderCardProps) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'accept' | 'reject' | 'prep' | null>(null);
  const [prep, setPrep] = useState(String(order.prepMinutes ?? defaultPrepMinutes));
  const [expired, setExpired] = useState(false);

  const done = (title: string) => () => {
    toast({ title, tone: 'success' });
    onChanged();
  };
  const failed = () => onChanged(); // e.g. ORDER_ACCEPT_WINDOW_EXPIRED: show the server's current state
  const accept = useMutation({ mutationFn: (m: number) => ordersApi.accept(order.id, m), onSuccess: done(`Order ${order.code} accepted`), onError: failed });
  const reject = useMutation({ mutationFn: (r: string) => ordersApi.reject(order.id, r), onSuccess: done(`Order ${order.code} rejected`), onError: failed });
  const preparing = useMutation({ mutationFn: () => ordersApi.preparing(order.id), onSuccess: done('Marked as preparing'), onError: failed });
  const ready = useMutation({ mutationFn: () => ordersApi.ready(order.id), onSuccess: done('Marked ready for pickup'), onError: failed });
  const setPrepTime = useMutation({ mutationFn: (m: number) => ordersApi.setPrepTime(order.id, m), onSuccess: done('Prep time updated'), onError: failed });

  const itemCount = order.lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal = order.breakdown?.itemsSubtotalPaise ?? order.breakdown?.totalPaise;
  const s = order.status;
  const showCode = (s === 'ACCEPTED' || s === 'PREPARING' || s === 'READY_FOR_PICKUP') && order.pickupCode;
  const windowClosed = expired || (order.acceptBy ? Date.parse(order.acceptBy) <= Date.now() : false);

  return (
    <Card
      as="li"
      padding="sm"
      aria-label={`Order ${order.code}`}
      className={cn('flex list-none flex-col gap-3', isNew && s === 'PLACED' && 'ring-2 ring-brand-500 motion-safe:animate-pop-in')}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <span className="font-mono">{order.code}</span>
            {isNew && s === 'PLACED' ? <Badge tone="brand" variant="solid">New</Badge> : null}
            {order.isDemo ? <Badge tone="info">Demo</Badge> : null}
          </h3>
          <p className="text-sm text-slate-600">
            {plural(itemCount, 'item')}
            {order.placedAt ? <> · <RelativeTime value={order.placedAt} prefix="placed" /></> : null}
            {order.customerContact?.name ? <> · {order.customerContact.name}{order.customerContact.phoneMasked ? ` ${formatPhone(order.customerContact.phoneMasked)}` : ''}</> : null}
          </p>
        </div>
        <StatusPill kind="childOrder" status={s} />
      </div>

      <ul className="flex flex-col gap-1.5 border-y border-slate-100 py-2">
        {order.lines.map((l, i) => (
          <li key={`${l.itemId ?? l.name}-${i}`} className="flex items-start gap-2 text-[0.9375rem]">
            <FoodMarker veg={l.isVeg ?? true} />
            <div className="min-w-0 flex-1">
              <p className="text-slate-900">
                <span className="font-semibold tabular-nums">{l.quantity} ×</span> {l.name}
              </p>
              {l.addOns?.length ? <p className="text-sm text-slate-600">{l.addOns.map((a) => a.name).join(', ')}</p> : null}
              {l.selectionNames?.length ? <p className="text-sm text-slate-600">{l.selectionNames.join(', ')}</p> : null}
              {l.note ? <p className="text-sm font-medium text-warn-800">Note: {l.note}</p> : null}
            </div>
            {typeof l.lineTotalPaise === 'number' ? <Price paise={l.lineTotalPaise} size="sm" tone="muted" /> : null}
          </li>
        ))}
        {subtotal !== undefined ? (
          <li className="flex justify-between pt-1 text-sm font-semibold text-slate-900">
            <span>Items total</span>
            <Price paise={subtotal} />
          </li>
        ) : null}
      </ul>

      {s === 'PLACED' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Icon name="clock" size={16} />
          <span className="text-slate-700">Accept within</span>
          <Countdown
            to={order.acceptBy}
            label="Time left to accept"
            expiredLabel="Window closed"
            onExpire={() => {
              setExpired(true);
              onChanged();
            }}
          />
          {windowClosed ? <span className="text-slate-600">This order will be rejected automatically and refunded.</span> : null}
        </div>
      ) : null}

      {(s === 'ACCEPTED' || s === 'PREPARING') && (order.readyEta || order.prepMinutes) ? (
        <p className="flex items-center gap-1.5 text-sm text-slate-700">
          <Icon name="clock" size={16} />
          {order.readyEta ? <>Ready by <strong className="tabular-nums">{formatTime(order.readyEta)}</strong></> : null}
          {order.prepMinutes ? <span className="text-slate-600">({order.prepMinutes} min prep)</span> : null}
        </p>
      ) : null}

      {showCode ? (
        <div className="rounded-control bg-brand-50 px-3 py-2 ring-1 ring-inset ring-brand-200" role="group" aria-label="Pickup code">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-800">Pickup code</p>
          <p className="font-mono text-2xl font-bold tracking-[0.3em] text-slate-900" data-testid="pickup-code">{order.pickupCode}</p>
          <p className="text-sm text-slate-700">Ask the delivery partner for this code before handing over the food.</p>
        </div>
      ) : null}

      <InlineError error={preparing.error ?? ready.error} />

      <div className="flex flex-wrap gap-2">
        {s === 'PLACED' ? (
          <>
            <Button onClick={() => setDialog('accept')} disabled={windowClosed} icon="check">Accept</Button>
            <Button variant="danger" onClick={() => setDialog('reject')} icon="x">Reject</Button>
          </>
        ) : null}
        {s === 'ACCEPTED' ? <Button onClick={() => preparing.mutate()} loading={preparing.isPending}>Start preparing</Button> : null}
        {s === 'ACCEPTED' || s === 'PREPARING' ? (
          <>
            <Button variant={s === 'PREPARING' ? 'primary' : 'secondary'} onClick={() => ready.mutate()} loading={ready.isPending} icon="check">Mark ready</Button>
            <Button variant="ghost" onClick={() => setDialog('prep')}>Update prep time</Button>
          </>
        ) : null}
        {s === 'READY_FOR_PICKUP' ? (
          <p className="flex items-center gap-1.5 text-sm text-slate-700">
            <Icon name="bike" size={16} /> Waiting for the delivery partner{order.deliveryStatus ? ` (${order.deliveryStatus.toLowerCase().replace(/_/g, ' ')})` : ''}.
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={dialog === 'accept'}
        onClose={() => setDialog(null)}
        title={`Accept order ${order.code}?`}
        description="Choose how long the order will take to prepare. The customer and the delivery partner see this time."
        confirmLabel="Accept order"
        onConfirm={() => accept.mutateAsync(Number(prep))}
      >
        <Field label="Preparation time" required>
          <Select value={prep} onChange={(e) => setPrep(e.target.value)} options={prepOptions(defaultPrepMinutes)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'prep'}
        onClose={() => setDialog(null)}
        title="Update preparation time"
        description="Let the customer and delivery partner know if the order will take longer."
        confirmLabel="Update"
        onConfirm={() => setPrepTime.mutateAsync(Number(prep))}
      >
        <Field label="New preparation time" required>
          <Select value={prep} onChange={(e) => setPrep(e.target.value)} options={prepOptions(order.prepMinutes ?? defaultPrepMinutes)} />
        </Field>
      </ConfirmDialog>
      <RejectDialog open={dialog === 'reject'} onClose={() => setDialog(null)} orderCode={order.code} onReject={(r) => reject.mutateAsync(r)} />
    </Card>
  );
}
