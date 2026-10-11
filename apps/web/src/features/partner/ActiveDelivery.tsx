/**
 * One active delivery (board 30, rows 30-20 … 30-27), every step a real API call (the server owns the state
 * machine and the code attempt counter):
 *   ASSIGNED          "I've arrived"    POST /deliveries/:id/arrived
 *   AT_PICKUP         pickup code  →    POST /deliveries/:id/pickup {code}     ("Restaurant's pickup code")
 *   PICKED_UP         "Start delivery"  POST /deliveries/:id/start
 *   OUT_FOR_DELIVERY  delivery code →   POST /deliveries/:id/deliver {code}    ("Customer's delivery code")
 *   PICKED_UP / OUT_FOR_DELIVERY  "Can't deliver" (reason) → POST /deliveries/:id/fail {reason}
 * Navigate goes to the restaurant before pickup and to the customer after (the drop address, coordinates and map
 * link only exist once the food is picked up — DLV-2). Call = DLV-1 `POST /deliveries/:id/contact {target}`:
 * DIRECT opens the dialer, DEMO only shows "Calling is simulated in demo" (never a fake call).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { CodeEntry } from '../../components/ui/CodeDigits';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Icon } from '../../components/ui/Icon';
import { PARTNER_STEPS, Stepper } from '../../components/ui/Stepper';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/errors';
import { formatTime, plural } from '../../lib/format';
import {
  confirmDelivered, confirmPickup, contactParty, failDelivery, markArrived, navigationUrl, partnerKeys, startDelivery,
  type ContactResult, type ContactTarget, type PartnerJob,
} from './api';
import { openDialer } from './dial';
import { CODE_MAX_ATTEMPTS, dropTitle, isPrePickup, partnerStep } from './format';

/** Design-spec 30-27: Customer unreachable / Address not found / Other (+ text; "Other" is added by ConfirmDialog). */
export const FAIL_REASONS = ['Customer unreachable', 'Address not found'];

const outlineLink =
  'inline-flex h-10 items-center justify-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-bold text-fg transition-colors hover:border-line-2 [@media(pointer:coarse)]:min-h-touch';

function attemptsFrom(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as { attemptsRemaining?: unknown } | undefined;
  return typeof d?.attemptsRemaining === 'number' ? d.attemptsRemaining : null;
}

export interface ActiveDeliveryProps {
  job: PartnerJob;
  /** 1-based position and total, for "Active delivery 1 of 2". */
  index?: number;
  total?: number;
  /** Called after any successful step with the updated job. */
  onChanged?: (job: PartnerJob) => void;
}

export function ActiveDelivery({ job, index = 1, total = 1, onChanged }: ActiveDeliveryProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const headingId = useId();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [failing, setFailing] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [contact, setContact] = useState<ContactResult | null>(null);
  // Attempts from the last wrong-code answer. The refetched job may lag behind (or catch up): the lower wins.
  const [knownLeft, setKnownLeft] = useState<number | null>(null);
  // Only a new step (or another job) clears the entry; a refetch after a wrong code must keep its message.
  useEffect(() => {
    setKnownLeft(null);
    setCode('');
    setCodeError(null);
    setContact(null);
  }, [job.id, job.status]);

  const status = job.status;
  const pre = isPrePickup(status);
  const left = knownLeft === null ? job.codeAttemptsRemaining : Math.min(knownLeft, job.codeAttemptsRemaining);
  const locked = left <= 0;
  const codeKind = status === 'AT_PICKUP' ? 'pickup' : status === 'OUT_FOR_DELIVERY' ? 'delivery' : null;
  const canFail = status === 'PICKED_UP' || status === 'OUT_FOR_DELIVERY';

  const done = (next: PartnerJob, message: string) => {
    setActionError(null);
    toast({ title: message, tone: next.status === 'FAILED' ? 'warn' : 'success' });
    void qc.invalidateQueries({ queryKey: partnerKeys.active });
    void qc.invalidateQueries({ queryKey: partnerKeys.profile });
    if (next.status === 'DELIVERED') void qc.invalidateQueries({ queryKey: ['partner', 'finance'] });
    onChanged?.(next);
  };

  const step = useMutation({
    mutationFn: async (): Promise<[PartnerJob, string]> => {
      switch (status) {
        case 'ASSIGNED':
          return [await markArrived(job.id), 'Marked as arrived'];
        case 'AT_PICKUP':
          return [await confirmPickup(job.id, code), 'Pickup confirmed'];
        case 'PICKED_UP':
          return [await startDelivery(job.id), 'Delivery started'];
        case 'OUT_FOR_DELIVERY':
          return [await confirmDelivered(job.id, code), 'Delivered. Nice work!'];
        default:
          throw new Error('Nothing to do for this delivery right now.');
      }
    },
    onMutate: () => {
      setActionError(null);
      setCodeError(null);
    },
    onSuccess: ([next, message]) => done(next, message),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DELIVERY_CODE_LOCKED') {
        setKnownLeft(0);
        setCode('');
        void qc.invalidateQueries({ queryKey: partnerKeys.active });
      } else if (e instanceof ApiError && e.code === 'DELIVERY_CODE_INVALID') {
        const next = attemptsFrom(e) ?? Math.max(0, left - 1);
        setKnownLeft(next);
        setCode('');
        setCodeError(`Wrong code · ${plural(next, 'attempt')} left`);
        void qc.invalidateQueries({ queryKey: partnerKeys.active });
      } else {
        setActionError(e);
      }
    },
  });

  const call = useMutation({
    mutationFn: (target: ContactTarget) => contactParty(job.id, target),
    onMutate: () => setContact(null),
    onSuccess: (res) => {
      setContact(res);
      if (res.mode !== 'DEMO' && res.telUrl) openDialer(res.telUrl);
    },
  });

  // Destination: the restaurant before pickup, the customer after.
  const navUrl = pre
    ? job.navigation.pickupUrl || navigationUrl(job.pickup.location)
    : job.navigation.dropUrl ?? (job.drop.location ? navigationUrl(job.drop.location) : null);
  const targets: ContactTarget[] = status === 'ASSIGNED' ? ['RESTAURANT'] : status === 'AT_PICKUP' ? ['RESTAURANT', 'CUSTOMER'] : canFail ? ['CUSTOMER'] : [];
  const ready = job.readyAt ? `Food ready since ${formatTime(job.readyAt)}` : job.readyEta ? `Expected ready around ${formatTime(job.readyEta)}` : null;
  const dropArea = job.drop.area ?? 'Area not shared';
  const code4 = /^\d{4}$/.test(code);
  const primary =
    status === 'ASSIGNED' ? 'I’ve arrived' : status === 'AT_PICKUP' ? 'Confirm pickup' : status === 'PICKED_UP' ? 'Start delivery' : status === 'OUT_FOR_DELIVERY' ? 'Mark delivered' : null;
  const primaryDisabled = codeKind !== null && (!code4 || locked);
  const ref = job.childOrderCode ?? job.checkoutCode;

  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-card border border-line bg-card" data-testid="active-delivery">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4 max-sm:px-4">
        <h2 id={headingId} className="font-sans text-[15px] font-semibold tracking-normal">
          Active delivery {index} of {total}
        </h2>
        {ref ? (
          <span className="font-mono text-xs text-fg-3">
            <span className="sr-only">Order </span>
            {ref}
          </span>
        ) : null}
      </div>

      <Stepper label="Delivery progress" steps={PARTNER_STEPS} current={partnerStep(status)} responsive={false} className="px-5 pt-4 max-sm:px-4" />

      <div className="flex flex-wrap items-end justify-between gap-6 px-5 py-[18px] max-sm:px-4">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          {pre ? (
            <>
              <span className="lbl">Pickup</span>
              <p className="text-xl font-semibold tracking-[-0.02em]">{job.pickup.name}</p>
              <p className="text-[13.5px] leading-normal text-fg-3">
                {job.pickup.address}
                {ready ? (
                  <>
                    <br />
                    {ready}
                  </>
                ) : null}
              </p>
              <p className="mt-1 flex items-start gap-2 text-[13px] text-fg-3">
                <span aria-hidden="true" className="mt-[5px] size-2 shrink-0 rounded-[2px] bg-acc" />
                <span>
                  Then drop · {dropTitle(dropArea, job.drop.label)} · full address after pickup
                </span>
              </p>
            </>
          ) : (
            <>
              <span className="lbl">Drop</span>
              <p className="text-xl font-semibold tracking-[-0.02em]">{dropTitle(job.drop.name, job.drop.label)}</p>
              <p className="text-[13.5px] leading-normal text-fg-3">
                {job.drop.address ?? `${dropArea} · address not available`}
                <br />
                <span className="tabular-nums">{job.drop.phoneMasked}</span>
              </p>
            </>
          )}
          <div className="mt-1.5 flex flex-wrap gap-2">
            {navUrl ? (
              <a
                href={navUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Navigate to ${pre ? job.pickup.name : 'the customer'} (opens Google Maps)`}
                className={outlineLink}
              >
                <Icon name="navigation" size={15} />
                Navigate
              </a>
            ) : null}
            {targets.map((t) => (
              <Button
                key={t}
                variant="outline"
                icon="phone"
                onClick={() => call.mutate(t)}
                loading={call.isPending && call.variables === t}
                disabled={call.isPending}
                aria-label={t === 'CUSTOMER' ? 'Call customer' : 'Call restaurant'}
              >
                {targets.length > 1 ? (t === 'CUSTOMER' ? 'Call customer' : 'Call restaurant') : 'Call'}
              </Button>
            ))}
          </div>
          <div aria-live="polite">
            {contact ? (
              <p className={cn('mt-2 rounded-control px-3 py-2 text-[13px]', contact.mode === 'DEMO' || !contact.telUrl ? 'bg-info-bg text-fg-2' : 'bg-fill text-fg-2')} data-testid="contact-note">
                {contact.mode === 'DEMO' || !contact.telUrl ? (
                  <>
                    <strong className="font-semibold text-info">{contact.note ?? 'Calling is simulated in demo'}</strong>
                    {' · '}
                    {contact.target === 'CUSTOMER' ? 'Customer' : 'Restaurant'} <span className="tabular-nums">{contact.displayNumber}</span>
                  </>
                ) : (
                  <>
                    Calling the {contact.target === 'CUSTOMER' ? 'customer' : 'restaurant'} · <span className="tabular-nums">{contact.displayNumber}</span>
                    {' · '}
                    <a href={contact.telUrl} className="font-semibold underline underline-offset-2">
                      Call again
                    </a>
                  </>
                )}
              </p>
            ) : null}
            <InlineError error={call.error} className="mt-2" />
          </div>
        </div>

        {codeKind ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!primaryDisabled && !step.isPending) step.mutate();
            }}
          >
            <CodeEntry
              length={4}
              value={code}
              onChange={(v) => {
                setCode(v);
                if (codeError) setCodeError(null);
              }}
              label={codeKind === 'pickup' ? 'Restaurant’s pickup code' : 'Customer’s delivery code'}
              disabled={locked || step.isPending}
              error={locked ? 'Locked after too many wrong tries. Contact Thali support to continue this delivery.' : codeError ?? undefined}
              hint={`${plural(left, 'attempt')} left · locks after ${CODE_MAX_ATTEMPTS} wrong tries`}
            />
            <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
          </form>
        ) : null}
      </div>

      <div className="px-5 pb-[18px] max-sm:px-4">
        <InlineError error={actionError} className="mb-3" />
        {primary ? (
          <div className="flex flex-wrap gap-2 max-sm:sticky max-sm:bottom-[calc(56px+env(safe-area-inset-bottom))] max-sm:z-10 max-sm:-mx-4 max-sm:border-t max-sm:border-line max-sm:bg-card max-sm:px-4 max-sm:py-3">
            <Button
              shape="block"
              size="lg"
              className="flex-[1_1_240px]"
              onClick={() => step.mutate()}
              disabled={primaryDisabled}
              loading={step.isPending}
            >
              {primary}
            </Button>
            {canFail ? (
              <Button variant="ghost" size="lg" onClick={() => setFailing(true)}>
                Can’t deliver
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={failing}
        onClose={() => setFailing(false)}
        title="Can’t deliver this order?"
        description="Only do this if you cannot complete the handover. Thali support is told and the customer is notified."
        confirmLabel="Mark as failed"
        tone="danger"
        reason={{ label: 'Reason', options: FAIL_REASONS, minLength: 3, maxLength: 500 }}
        onConfirm={async (reason) => {
          const next = await failDelivery(job.id, reason ?? '');
          done(next, 'Delivery marked as failed');
        }}
      />
    </section>
  );
}
