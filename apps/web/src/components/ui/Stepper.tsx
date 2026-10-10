/**
 * Stepper / timeline (design-spec §3.16): segmented bars with a label (+ optional mono time) per step.
 * done = --fg bar · current = --acc bar with pulse, label in --acc-fg · future = --line bar, label --fg3.
 * ≤640px the order timeline becomes a vertical list (`responsive`, default true for 5+ steps).
 *
 *   <Stepper label="Order progress" steps={ORDER_STEPS.map((l, i) => ({ label: l, time: times[i] }))} current={5} />
 *   <Stepper label="Refund" tone="refund" steps={REFUND_STEPS} current={1} />          // ok done bars, info current
 *   <Stepper label="Order progress" steps={...} current={2}
 *     terminal={{ label: 'Rejected by restaurant', tone: 'bad' }} />                  // stops + one red bar
 *   <StepNumber n={1} />   // checkout step circle (26px, mono)
 */
import { cn } from '../../lib/cn';

export const ORDER_STEPS = ['Placed', 'Accepted', 'Preparing', 'Ready', 'Picked up', 'On the way', 'Delivered'] as const;
export const PARTNER_STEPS = ['At restaurant', 'Picked up', 'On the way', 'Deliver'] as const;
export const REFUND_STEPS = ['Initiated', 'Processing', 'Refunded'] as const;

export interface StepItem {
  label: string;
  /** Mono time under the label ("7:42"); current shows "now", future "—" when `showTimes`. */
  time?: string;
}

export interface StepperProps {
  steps: ReadonlyArray<StepItem | string>;
  /** Index of the current step (all before it are done). Use steps.length when everything is done. */
  current: number;
  /** Accessible name of the list. */
  label: string;
  tone?: 'order' | 'refund';
  /** Refund failed / order rejected / cancelled: replaces the remaining steps with one bar. */
  terminal?: { label: string; tone: 'bad' | 'neu' };
  showTimes?: boolean;
  /** Vertical list on phones (default: when there are 5+ steps). */
  responsive?: boolean;
  className?: string;
}

type State = 'done' | 'current' | 'future' | 'terminal';

export function Stepper({ steps, current, label, tone = 'order', terminal, showTimes, responsive, className }: StepperProps) {
  const items = steps.map((s) => (typeof s === 'string' ? { label: s } : s));
  const shown: Array<StepItem & { state: State }> = items
    .slice(0, terminal ? current : items.length)
    .map((s, i) => ({ ...s, state: i < current ? 'done' : i === current ? 'current' : 'future' }));
  if (terminal) shown.push({ label: terminal.label, state: 'terminal' });
  const vertical = responsive ?? items.length >= 5;
  const times = showTimes ?? items.some((s) => s.time !== undefined);

  const bar = (st: State) =>
    st === 'done'
      ? tone === 'refund'
        ? 'bg-ok'
        : 'bg-fg'
      : st === 'current'
        ? tone === 'refund'
          ? 'bg-info'
          : 'bg-acc animate-pulse-live'
        : st === 'terminal'
          ? terminal?.tone === 'bad'
            ? 'bg-bad'
            : 'bg-neu'
          : 'bg-line';
  const text = (st: State) =>
    st === 'done'
      ? 'font-medium text-fg'
      : st === 'current'
        ? tone === 'refund'
          ? 'font-semibold text-info'
          : 'font-semibold text-acc-fg'
        : st === 'terminal'
          ? terminal?.tone === 'bad'
            ? 'font-semibold text-bad'
            : 'font-semibold text-fg-3'
          : 'text-fg-3';

  return (
    <ol
      aria-label={label}
      className={cn('grid gap-1.5', vertical && 'max-sm:grid-cols-1! max-sm:gap-0', className)}
      style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
    >
      {shown.map((s, i) => (
        <li
          key={`${s.label}-${i}`}
          aria-current={s.state === 'current' ? 'step' : undefined}
          className={cn('flex min-w-0 flex-col gap-2', vertical && 'max-sm:flex-row max-sm:items-stretch max-sm:gap-3')}
        >
          <span aria-hidden="true" className={cn('h-1 rounded-[2px]', bar(s.state), vertical && 'max-sm:h-auto max-sm:min-h-9 max-sm:w-1')} />
          <span className={cn('flex flex-col gap-1', vertical && 'max-sm:py-1.5')}>
            <span className={cn('text-[12.5px] leading-tight', text(s.state))}>
              {s.label}
              <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current)' : s.state === 'future' ? ' (upcoming)' : ''}</span>
            </span>
            {times && s.state !== 'terminal' ? (
              <span className="font-mono text-[11px] text-fg-3">{s.time ?? (s.state === 'current' ? 'now' : s.state === 'future' ? '—' : '')}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Checkout step number: 26px circle, mono 12px. */
export function StepNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid size-[26px] shrink-0 place-items-center rounded-full border border-line font-mono text-xs font-medium text-fg-2', className)}>
      {n}
    </span>
  );
}

/** @deprecated alias — the design calls it a timeline too. */
export const Timeline = Stepper;
