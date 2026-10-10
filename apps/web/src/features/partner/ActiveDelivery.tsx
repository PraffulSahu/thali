/**
 * One active delivery: pickup + drop cards with Google Maps navigation, and the step actions
 *   ASSIGNED -> "I've arrived" -> AT_PICKUP -> pickup code -> PICKED_UP -> "Start delivery" -> OUT_FOR_DELIVERY
 *   -> delivery code -> DELIVERED;  PICKED_UP / OUT_FOR_DELIVERY -> "Can't deliver" (reason) -> FAILED.
 * Every action is a real API call; the server owns the state machine and the code attempt counter.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { buttonClasses, Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Icon } from '../../components/ui/Icon';
import { StatusPill } from '../../components/ui/StatusPill';
import { useToast } from '../../components/ui/Toast';
import { formatDistanceKm, formatMinutes, formatTime } from '../../lib/format';
import {
  confirmDelivered, confirmPickup, failDelivery, markArrived, navigationUrl, partnerKeys, startDelivery,
  type GeoPoint, type PartnerJob,
} from './api';
import { CodeEntryDialog, type CodeKind } from './CodeEntryDialog';
import { EstimateBadge } from './OfferCard';

export const FAIL_REASONS = ['Customer unreachable', 'Wrong or incomplete address', 'Customer refused the order', 'Vehicle breakdown or accident'];

function StopCard({ title, name, address, point, linkLabel, current, extra }: {
  title: string; name: string; address: string; point: GeoPoint; linkLabel: string; current: boolean; extra?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className={`rounded-control border p-3 ${current ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-surface'}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
        <Icon name={title === 'Pickup' ? 'store' : 'home'} size={14} />
        {title}
        {current ? <span className="rounded-pill bg-brand-600 px-2 py-0.5 text-[0.6875rem] text-white">Next stop</span> : null}
      </p>
      <p className="mt-1 font-semibold text-slate-900">{name}</p>
      <p className="text-sm text-slate-700">{address}</p>
      {extra}
      <a
        href={navigationUrl(point)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${linkLabel} (opens Google Maps)`}
        className={buttonClasses('secondary', 'md', false, 'mt-3 w-full sm:w-auto')}
      >
        <Icon name="map" size={18} />
        {linkLabel}
        <Icon name="external" size={14} />
      </a>
    </section>
  );
}

export interface ActiveDeliveryProps {
  job: PartnerJob;
  /** Called after any successful step with the updated job. */
  onChanged?: (job: PartnerJob) => void;
}

export function ActiveDelivery({ job, onChanged }: ActiveDeliveryProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [codeKind, setCodeKind] = useState<CodeKind | null>(null);
  const [failing, setFailing] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const done = (next: PartnerJob, message?: string) => {
    setActionError(null);
    if (message) toast({ title: message, tone: next.status === 'FAILED' ? 'warn' : 'success' });
    void qc.invalidateQueries({ queryKey: partnerKeys.active });
    void qc.invalidateQueries({ queryKey: partnerKeys.profile });
    onChanged?.(next);
  };

  const arrived = useMutation({ mutationFn: () => markArrived(job.id), onSuccess: (j) => done(j, 'Marked as arrived'), onError: setActionError });
  const start = useMutation({ mutationFn: () => startDelivery(job.id), onSuccess: (j) => done(j, 'Delivery started'), onError: setActionError });

  const status = job.status;
  const nextStop = status === 'PICKED_UP' || status === 'OUT_FOR_DELIVERY' ? 'drop' : 'pickup';
  const canFail = status === 'PICKED_UP' || status === 'OUT_FOR_DELIVERY';
  const ready = job.readyAt ? `Food ready since ${formatTime(job.readyAt)}` : job.readyEta ? `Expected ready around ${formatTime(job.readyEta)}` : null;

  return (
    <Card as="article" aria-label={`Delivery ${job.childOrderId}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">Order {job.childOrderId}</h3>
        <StatusPill kind="delivery" status={status} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
        <span className="tabular-nums">{formatDistanceKm(job.distanceKm)}</span>
        <span className="tabular-nums">about {formatMinutes(job.estimatedMinutes)}</span>
        <EstimateBadge source={job.estimateSource} />
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <StopCard
          title="Pickup"
          name={job.pickup.name}
          address={job.pickup.address}
          point={job.pickup.location}
          linkLabel="Navigate to pickup"
          current={nextStop === 'pickup'}
          extra={ready ? <p className="mt-1 text-sm text-slate-600">{ready}</p> : null}
        />
        <StopCard
          title="Drop"
          name={job.drop.name}
          address={job.drop.address}
          point={job.drop.location}
          linkLabel="Navigate to drop"
          current={nextStop === 'drop'}
          extra={<p className="mt-1 text-sm text-slate-600">Customer phone <span className="tabular-nums">{job.drop.phoneMasked}</span></p>}
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        {status === 'ASSIGNED' ? (
          <Button onClick={() => arrived.mutate()} loading={arrived.isPending} icon="check">
            I've arrived at the restaurant
          </Button>
        ) : null}
        {status === 'AT_PICKUP' ? <Button onClick={() => setCodeKind('pickup')}>Enter pickup code</Button> : null}
        {status === 'PICKED_UP' ? (
          <Button onClick={() => start.mutate()} loading={start.isPending} icon="bike">
            Start delivery
          </Button>
        ) : null}
        {status === 'OUT_FOR_DELIVERY' ? <Button onClick={() => setCodeKind('delivery')}>Enter delivery code</Button> : null}
        {canFail ? (
          <Button variant="danger" onClick={() => setFailing(true)}>
            Can't deliver
          </Button>
        ) : null}
      </div>
      <InlineError error={actionError} />

      <CodeEntryDialog
        open={codeKind !== null}
        onClose={() => setCodeKind(null)}
        kind={codeKind ?? 'pickup'}
        attemptsRemaining={job.codeAttemptsRemaining}
        onSubmit={async (code) => {
          const next = codeKind === 'delivery' ? await confirmDelivered(job.id, code) : await confirmPickup(job.id, code);
          done(next, codeKind === 'delivery' ? 'Delivered. Nice work!' : 'Pickup confirmed');
        }}
      />
      <ConfirmDialog
        open={failing}
        onClose={() => setFailing(false)}
        title="Mark delivery as failed?"
        description="Only do this if you cannot complete the handover. Support is told and the customer is notified."
        confirmLabel="Mark as failed"
        tone="danger"
        reason={{ label: 'Reason', options: FAIL_REASONS, minLength: 3, maxLength: 500 }}
        onConfirm={async (reason) => {
          const next = await failDelivery(job.id, reason ?? '');
          done(next, 'Delivery marked as failed');
        }}
      />
    </Card>
  );
}
