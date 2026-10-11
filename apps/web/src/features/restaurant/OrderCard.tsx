/**
 * Owner order cards (design-spec §3.26, board 20):
 *   NewOrderCard        PLACED — accept-by ring (red ≤ 60 s), items + options + notes, prep pills 10/15/20/30 (+ other
 *                       times), Reject → inline reason mode (Out of stock / Kitchen busy / Closing soon / Other…), Accept · N min
 *   PreparingCard       ACCEPTED / PREPARING — items line, prep progress from acceptedAt + readyEta/prepMinutes,
 *                       rider line, Change time, Start preparing / Mark ready
 *   ReadyCard           READY_FOR_PICKUP — pickup code boxes, rider row + delivery chip
 * Every action calls the orders API; failures toast and refetch so the card shows the server's truth.
 */
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Avatar, Badge, Button, ChoicePills, CodeDigits, CountdownRing, FoodMarker, KanbanEmpty, ProgressBar, StatusPill, Textarea, useToast,
} from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { PREP_TIME_OPTIONS, allowedActions, ordersApi, type OwnerOrder } from './api';
import { Popover } from './kit';
import { PREP_PILLS, firstName, hasPartner, itemsLine, maskedPhone, optionText, partnerText, prepProgress } from './orderText';

export type EndedKind = 'auto' | 'rejected';

export const REJECT_REASONS = ['Out of stock', 'Kitchen busy', 'Closing soon'] as const;

interface CommonProps {
  order: OwnerOrder;
  /** Refetch the board after a change (or a failure, to show the server's state). */
  onChanged: () => void;
  /** Open the detail dialog (card click). */
  onOpen: (o: OwnerOrder) => void;
  className?: string;
}

/** Card frame: whole-card click opens details (clicks on controls are ignored), the code is a real button. */
function CardFrame({ order, onOpen, className, children, label, accent }: { order: OwnerOrder; onOpen: (o: OwnerOrder) => void; className?: string; children: ReactNode; label?: string; /** New card: accent border (board 20) */ accent?: boolean }) {
  const click = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button,a,input,select,textarea,label')) return;
    onOpen(order);
  };
  return (
    <li aria-label={label ?? `Order ${order.code}`} onClick={click} className={cn('flex cursor-pointer list-none flex-col rounded-card border bg-card p-4', accent ? 'border-acc' : 'border-line', className)}>
      {children}
    </li>
  );
}

function CodeButton({ order, onOpen }: { order: OwnerOrder; onOpen: (o: OwnerOrder) => void }) {
  return (
    <button type="button" onClick={() => onOpen(order)} className="w-fit text-left font-mono text-sm font-medium text-fg hover:underline" aria-label={`Order ${order.code}, view details`}>
      {order.code}
    </button>
  );
}

/** "8:14 PM" (IST, board 20 style). */
const time = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(iso)).toUpperCase() : '';

/* ------------------------------------------------------------------ New */

export interface NewOrderCardProps extends CommonProps {
  /** Arrived after the board opened: arrive animation + ring. */
  isNew?: boolean;
  defaultPrep: number;
  /** The order left the New column on this device (auto-rejected window, or rejected here). */
  onEnded: (o: OwnerOrder, kind: EndedKind) => void;
}

export function NewOrderCard({ order, isNew, defaultPrep, onChanged, onOpen, onEnded, className }: NewOrderCardProps) {
  const { toast } = useToast();
  const id = useId();
  const [prep, setPrep] = useState<number>(defaultPrep);
  const [mode, setMode] = useState<'new' | 'reject'>('new');
  const [other, setOther] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const fail = (what: string) => (e: unknown) => {
    toast({ title: `Couldn't ${what} ${order.code}`, description: errorMessage(e), tone: 'danger' });
    onChanged();
  };
  const accept = useMutation({
    mutationFn: (m: number) => ordersApi.accept(order.id, m),
    onSuccess: () => {
      toast({ title: `${order.code} accepted · ${prep} min`, tone: 'success' });
      onChanged();
    },
    onError: fail('accept'),
  });
  const reject = useMutation({
    mutationFn: (reason: string) => ordersApi.reject(order.id, reason),
    onSuccess: () => {
      onEnded(order, 'rejected');
      onChanged();
    },
    onError: fail('reject'),
  });

  const windowClosed = expired || (order.acceptBy ? Date.parse(order.acceptBy) <= Date.now() : false);
  const actions = windowClosed ? [] : allowedActions(order);
  if (windowClosed || (actions.length === 0 && order.allowedTransitions)) {
    return (
      <li className="list-none">
        <KanbanEmpty title="Auto-rejected — the accept window passed" sub={`${order.code} · the customer is being refunded`} />
      </li>
    );
  }

  const placed = order.placedAt ? Date.parse(order.placedAt) : NaN;
  const by = order.acceptBy ? Date.parse(order.acceptBy) : NaN;
  const windowSec = !Number.isNaN(placed) && !Number.isNaN(by) && by > placed ? Math.round((by - placed) / 1000) : 300;
  const notes = order.lines.filter((l) => l.note?.trim());
  const busy = accept.isPending || reject.isPending;
  const extraTimes = PREP_TIME_OPTIONS.filter((m) => !(PREP_PILLS as readonly number[]).includes(m));
  const customer = firstName(order.customer?.name);

  return (
    <CardFrame
      order={order}
      onOpen={onOpen}
      label={`New order ${order.code}`}
      accent
      className={cn('gap-3.5', isNew && 'motion-safe:animate-arrive', className)}
    >
      <div className="flex justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CodeButton order={order} onOpen={onOpen} />
          <span className="text-[12.5px] text-fg-3">
            {[time(order.placedAt), customer, maskedPhone(order.customer?.phoneMasked)].filter(Boolean).join(' · ')}
          </span>
        </div>
        <CountdownRing
          to={order.acceptBy}
          totalSec={windowSec}
          variant="accept"
          label="left to accept"
          onExpire={() => {
            setExpired(true);
            onEnded(order, 'auto');
            onChanged();
          }}
        />
      </div>

      <div className="flex flex-col gap-2 text-[14.5px]">
        <ul className="flex flex-col gap-2">
          {order.lines.map((l, i) => (
            <li key={`${l.itemId ?? l.name}-${i}`} className="flex gap-2.5">
              <span className="min-w-6 font-mono font-semibold">{l.quantity}×</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  {typeof l.isVeg === 'boolean' ? <FoodMarker veg={l.isVeg} size={12} /> : null}
                  {l.name}
                </span>
                {optionText(l) ? <span className="text-[12.5px] text-fg-3">{optionText(l)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {notes.map((l, i) => (
          <p key={i} className="rounded-item bg-warn-bg px-2.5 py-2 text-[13px] text-warn">
            Note{notes.length > 1 ? ` (${l.name})` : ''}: {l.note}
          </p>
        ))}
      </div>

      {mode === 'new' ? (
        <>
          <div className="flex flex-col gap-2">
            <span className="flex items-center justify-between gap-2 text-[12.5px] text-fg-3">
              <span id={`${id}-prep`}>Prep time</span>
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Other prep time</span>
                <select
                  value={(PREP_PILLS as readonly number[]).includes(prep) ? '' : String(prep)}
                  onChange={(e) => e.target.value && setPrep(Number(e.target.value))}
                  className="h-7 rounded-xs border border-line bg-card px-1.5 text-[12.5px] text-fg-2"
                >
                  <option value="">Other…</option>
                  {extraTimes.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
            </span>
            <ChoicePills
              label="Prep time"
              columns={4}
              value={String(prep)}
              onChange={(v) => setPrep(Number(v))}
              options={PREP_PILLS.map((m) => ({ value: String(m), label: `${m} min`, disabled: busy }))}
            />
          </div>
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            {actions.includes('reject') ? (
              <Button variant="danger-outline" shape="block" size="lg" className="min-w-0 px-3 hover:border-line-2" disabled={busy} onClick={() => setMode('reject')}>
                Reject
              </Button>
            ) : (
              <span />
            )}
            {actions.includes('accept') ? (
              <Button shape="block" size="lg" className="min-w-0 px-3 text-[15px]" loading={accept.isPending} disabled={reject.isPending} onClick={() => accept.mutate(prep)}>
                Accept · {prep} min
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-reason`}>
          <span id={`${id}-reason`} className="text-sm font-medium text-fg">
            Reason <span className="font-normal text-fg-3">(required)</span>
          </span>
          {other === null ? (
            <div className="grid grid-cols-2 gap-1.5">
              {REJECT_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  aria-pressed={reject.isPending && reject.variables === r}
                  onClick={() => reject.mutate(r)}
                  className="h-11 rounded-control border border-line bg-card px-2 text-sm font-medium text-fg hover:border-line-2 disabled:opacity-45"
                >
                  {reject.isPending && reject.variables === r ? 'Rejecting…' : r}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => setOther('')}
                className="h-11 rounded-control border border-line bg-card px-2 text-sm font-medium text-fg hover:border-line-2 disabled:opacity-45"
              >
                Other…
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${id}-other`} className="text-[13px] text-fg-3">
                Tell the customer what happened
              </label>
              <Textarea id={`${id}-other`} rows={2} maxLength={500} value={other} onChange={(e) => setOther(e.target.value)} autoFocus />
              <Button
                variant="danger"
                shape="block"
                size="lg"
                loading={reject.isPending}
                disabled={other.trim().length < 3}
                onClick={() => reject.mutate(other.trim())}
              >
                Reject order
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            disabled={reject.isPending}
            onClick={() => {
              if (other !== null) setOther(null);
              else setMode('new');
            }}
          >
            Back
          </Button>
        </div>
      )}
    </CardFrame>
  );
}

/* ------------------------------------------------------------------ Preparing */

function ChangeTime({ order, onChanged }: { order: OwnerOrder; onChanged: () => void }) {
  const { toast } = useToast();
  const [m, setM] = useState<string>(String(order.prepMinutes ?? 20));
  const save = useMutation({
    mutationFn: (minutes: number) => ordersApi.setPrepTime(order.id, minutes),
    onSuccess: (_d, minutes) => {
      toast({ title: `${order.code}: ready in ${minutes} min`, tone: 'success' });
      onChanged();
    },
    onError: (e) => {
      toast({ title: "Couldn't change the prep time", description: errorMessage(e), tone: 'danger' });
      onChanged();
    },
  });
  return (
    <Popover
      label={`Change prep time for ${order.code}`}
      align="start"
      panelClassName="w-[300px] p-3"
      trigger={(p) => (
        <button type="button" {...p} className="font-medium text-fg-2 underline underline-offset-2 hover:text-fg">
          Change time
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2.5">
          <p className="text-sm font-medium text-fg">Ready in…</p>
          <p className="text-[12.5px] text-fg-3">Minutes from now. The customer and the rider see the new time.</p>
          <ChoicePills
            label="Ready in"
            columns={3}
            value={m}
            onChange={setM}
            options={[...new Set([...PREP_TIME_OPTIONS, ...(order.prepMinutes && order.prepMinutes <= 120 ? [order.prepMinutes] : [])])]
              .sort((a, b) => a - b)
              .map((x) => ({ value: String(x), label: `${x} min` }))}
          />
          <Button shape="block" fullWidth loading={save.isPending} onClick={() => save.mutate(Number(m), { onSuccess: close })}>
            Update · {m} min
          </Button>
        </div>
      )}
    </Popover>
  );
}

export function PreparingCard({ order, onChanged, onOpen, className }: CommonProps) {
  const { toast } = useToast();
  const now = useNow(15_000);
  const actions = allowedActions(order);
  const run = (fn: () => Promise<unknown>, ok: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast({ title: ok, tone: 'success' });
      onChanged();
    },
    onError: (e: unknown) => {
      toast({ title: `Couldn't update ${order.code}`, description: errorMessage(e), tone: 'danger' });
      onChanged();
    },
  });
  const preparing = useMutation(run(() => ordersApi.preparing(order.id), `${order.code} is being prepared`));
  const ready = useMutation(run(() => ordersApi.ready(order.id), `${order.code} is ready for pickup`));
  const progress = prepProgress(order, now);
  const canReady = actions.includes('ready');
  const canPrep = actions.includes('preparing');
  // row 20-36: the first allowed transition is the primary action (ACCEPTED → Start preparing, PREPARING → Mark ready)
  const primary: 'preparing' | 'ready' | null = canPrep ? 'preparing' : canReady ? 'ready' : null;

  return (
    <CardFrame order={order} onOpen={onOpen} className={cn('gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <CodeButton order={order} onOpen={onOpen} />
        <span className="truncate text-[12.5px] text-fg-3">{firstName(order.customer?.name)}</span>
      </div>
      <p className="text-sm leading-[1.45] text-fg">{itemsLine(order)}</p>
      {progress ? (
        <ProgressBar
          value={progress.elapsed}
          max={progress.total}
          overdue={progress.overdue}
          label={`Preparation of ${order.code}`}
          left={progress.text}
          right={partnerText(order)}
        />
      ) : (
        <p className="text-xs text-fg-3">{partnerText(order)}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
        {order.readyEta ? <span>Ready by {time(order.readyEta)}</span> : null}
        <ChangeTime order={order} onChanged={onChanged} />
        {primary === 'preparing' && canReady ? (
          <button type="button" onClick={() => ready.mutate()} disabled={ready.isPending} className="font-medium text-fg-2 underline underline-offset-2 hover:text-fg disabled:opacity-45">
            {ready.isPending ? 'Updating…' : 'Skip to ready'}
          </button>
        ) : null}
      </div>
      {primary === 'preparing' ? (
        <Button shape="block" size="lg" className="h-11" fullWidth loading={preparing.isPending} onClick={() => preparing.mutate()}>
          Start preparing
        </Button>
      ) : primary === 'ready' ? (
        <Button shape="block" size="lg" className="h-11" fullWidth loading={ready.isPending} onClick={() => ready.mutate()}>
          Mark ready
        </Button>
      ) : null}
    </CardFrame>
  );
}

/* ------------------------------------------------------------------ Ready */

export function ReadyCard({ order, onOpen, className }: CommonProps) {
  const name = firstName(order.partner?.name);
  return (
    <CardFrame order={order} onOpen={onOpen} className={cn('gap-3.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <CodeButton order={order} onOpen={onOpen} />
        <span className="truncate text-[12.5px] text-fg-3">{firstName(order.customer?.name)}</span>
      </div>
      <p className="text-sm text-fg">{itemsLine(order)}</p>
      {order.pickupCode ? (
        <div className="flex flex-col items-center gap-2.5 rounded-control border border-line bg-bg-2 p-3.5">
          <span className="text-[12.5px] text-fg-3">Pickup code &mdash; the rider tells you this</span>
          <CodeDigits code={order.pickupCode} label="Pickup code" size="lg" />
        </div>
      ) : null}
      <div className="flex items-center gap-2.5 text-[13.5px]">
        <Avatar name={name || '?'} size={30} />
        <span className="min-w-0 flex-1 truncate">{partnerText(order)}</span>
        {hasPartner(order) ? (
          <Badge tone="info" dot>
            Partner assigned
          </Badge>
        ) : order.deliveryStatus ? (
          <StatusPill kind="delivery" status={order.deliveryStatus} />
        ) : (
          <Badge tone="warn" dot>
            Finding a partner
          </Badge>
        )}
      </div>
    </CardFrame>
  );
}
