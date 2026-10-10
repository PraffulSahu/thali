/**
 * Countdown ring (design-spec §3.14): SVG ring draining toward the server deadline with a centred mono number.
 * The ring turns --bad under the danger threshold; the offer variant also pulses (`urgent`).
 *
 *   <CountdownRing to={order.acceptBy} totalSec={300} variant="accept" label="left to accept"
 *     onExpire={() => orders.refetch()} />                                  // 56px, "4:01", red ≤ 60 s
 *   <CountdownRing to={offer.expiresAt} totalSec={45} variant="offer" label="to accept the offer" />
 *                                                                          // 64px, "11", red + pulse ≤ 10 s
 *   <CountdownRing secondsLeft={272} totalSec={300} variant="sample" />    // controlled (foundations, tests)
 *
 * role="timer"; the accessible name is a sentence ("4 minutes 1 second left to accept"). At 0 `onExpire`
 * fires once; switch the card to its expired state there.
 */
import { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useCountdown } from './Countdown';

type Variant = 'accept' | 'offer' | 'sample';

const PRESETS: Record<Variant, { box: number; r: number; stroke: number; text: string; danger: number; format: 'mss' | 's' }> = {
  accept: { box: 56, r: 24, stroke: 5, text: 'text-[13px] font-medium', danger: 60, format: 'mss' },
  offer: { box: 64, r: 28, stroke: 5, text: 'text-[17px] font-medium', danger: 10, format: 's' },
  sample: { box: 40, r: 18, stroke: 4, text: 'text-[11px] font-semibold', danger: 60, format: 'mss' },
};

/** stroke-dashoffset for `remaining` of `total` seconds on a ring of circumference `c` (clamped). */
export function ringProgress(c: number, remaining: number, total: number): number {
  if (total <= 0) return c;
  const frac = Math.min(1, Math.max(0, remaining / total));
  return c * (1 - frac);
}

function spoken(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return m > 0 ? `${part(m, 'minute')} ${part(s, 'second')}` : part(s, 'second');
}

export interface CountdownRingProps {
  /** Deadline (ISO string, epoch ms or Date). Ignored when `secondsLeft` is given. */
  to?: string | number | Date | null;
  /** Controlled remaining seconds (no clock). */
  secondsLeft?: number;
  /** Full window in seconds (accept window 300, offer 45). */
  totalSec: number;
  variant?: Variant;
  /** Override the danger threshold (seconds). */
  dangerBelowSec?: number;
  /** Tail of the accessible sentence: "left to accept". */
  label?: string;
  onExpire?: () => void;
  className?: string;
}

export function CountdownRing({ to, secondsLeft, totalSec, variant = 'accept', dangerBelowSec, label = 'left', onExpire, className }: CountdownRingProps) {
  const live = useCountdown(secondsLeft === undefined ? to : null);
  const left = secondsLeft ?? live ?? 0;
  const p = PRESETS[variant];
  const threshold = dangerBelowSec ?? p.danger;
  const danger = left <= threshold;
  const c = 2 * Math.PI * p.r;
  const mid = p.box / 2;

  const fired = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });
  useEffect(() => {
    if (left === 0 && !fired.current && (secondsLeft !== undefined || live !== null)) {
      fired.current = true;
      onExpireRef.current?.();
    }
    if (left > 0) fired.current = false;
  }, [left, live, secondsLeft]);

  const text = p.format === 's' ? String(left) : formatDuration(left);
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center rounded-full', variant === 'offer' && danger && left > 0 && 'animate-urgent', className)}
      style={{ width: p.box, height: p.box }}
    >
      <svg viewBox={`0 0 ${p.box} ${p.box}`} width={p.box} height={p.box} aria-hidden="true" className="absolute inset-0">
        <circle cx={mid} cy={mid} r={p.r} fill="none" stroke="var(--muted)" strokeWidth={p.stroke} />
        <circle
          cx={mid}
          cy={mid}
          r={p.r}
          fill="none"
          stroke={danger ? 'var(--bad)' : 'var(--acc)'}
          strokeWidth={p.stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={ringProgress(c, left, totalSec)}
          transform={`rotate(-90 ${mid} ${mid})`}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke .2s' }}
        />
      </svg>
      <span
        role="timer"
        aria-live="off"
        aria-label={`${spoken(left)} ${label}`}
        data-danger={String(danger)}
        className={cn('relative font-mono tabular-nums leading-none', p.text, danger ? 'text-bad' : 'text-fg')}
      >
        {text}
      </span>
    </span>
  );
}
