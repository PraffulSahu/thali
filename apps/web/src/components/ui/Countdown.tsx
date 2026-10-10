/**
 * Countdown to a deadline (accept window, offer expiry, checkout TTL, OTP resend).
 *
 *   <Countdown to={order.acceptBy} onExpire={() => order.refetch()} />       "4:59", warn under 60 s
 *   <Countdown to={offer.expiresAt} expiredLabel="Offer expired" />
 *   const secondsLeft = useCountdown(deadline);                              hook form
 *
 * `role="timer"` with aria-live off (a ticking value would be noisy); an sr-only sentence announces
 * expiry once.
 */
import { useEffect, useRef } from 'react';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { Icon } from './Icon';

function toMs(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole seconds remaining until `to` (0 when passed, null when `to` is empty). */
export function useCountdown(to: string | number | Date | null | undefined): number | null {
  const now = useNow(1000);
  const target = toMs(to);
  return target === null ? null : Math.max(0, Math.ceil((target - now) / 1000));
}

export interface CountdownProps {
  to: string | number | Date | null | undefined;
  onExpire?: () => void;
  expiredLabel?: string;
  /** Seconds at which the display turns urgent (default 60). */
  warnBelowSec?: number;
  showIcon?: boolean;
  /** Accessible description, e.g. "Time left to accept". */
  label?: string;
  className?: string;
}

export function Countdown({ to, onExpire, expiredLabel = 'Expired', warnBelowSec = 60, showIcon = true, label, className }: CountdownProps) {
  const left = useCountdown(to);
  const fired = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpireRef.current?.();
    }
    if (left !== null && left > 0) fired.current = false;
  }, [left]);

  if (left === null) return null;
  const expired = left === 0;
  const urgent = !expired && left <= warnBelowSec;
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label={label ? `${label}: ${expired ? expiredLabel : formatDuration(left)}` : undefined}
      className={cn(
        'inline-flex items-center gap-1 font-semibold tabular-nums',
        expired ? 'text-slate-500' : urgent ? 'text-danger-700' : 'text-slate-800',
        className,
      )}
    >
      {showIcon ? <Icon name="clock" size={16} /> : null}
      {expired ? expiredLabel : formatDuration(left)}
      {expired ? <span className="sr-only" role="status">{expiredLabel}</span> : null}
    </span>
  );
}
