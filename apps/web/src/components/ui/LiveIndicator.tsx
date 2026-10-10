/**
 * Live indicator (design-spec §3.13). Pass the realtime status from `useRealtime()`.
 *
 *   <LiveIndicator status={status} updatedAt={lastEventAt} />            // pill: "Live · updated 3s ago"
 *   <LiveIndicator status={status} variant="inline" />                    // owner: green dot + "Live"
 *   <LiveIndicator status={status} variant="inline" tone="ok"
 *     text="Location sharing active" updatedAt={lastSentAt} updatedPrefix="last sent" />   // partner
 *
 * live → pulsing dot (acc for the pill, ok for inline) · polling/reconnecting → static --warn dot on
 * --warn-bg with "Live updates paused — refreshing every 10 s" · connecting → nothing (no flash).
 */
import type { RealtimeStatus } from '../../lib/realtime';
import { REALTIME_PAUSED_MESSAGE } from '../../lib/realtime';
import { cn } from '../../lib/cn';
import { RelativeTime } from './RelativeTime';

export interface LiveIndicatorProps {
  status: RealtimeStatus;
  variant?: 'pill' | 'inline';
  /** Dot colour while live (default: acc for pill, ok for inline). */
  tone?: 'acc' | 'ok';
  text?: string;
  updatedAt?: string | number | Date | null;
  updatedPrefix?: string;
  className?: string;
}

export function LiveIndicator({ status, variant = 'pill', tone, text = 'Live', updatedAt, updatedPrefix = 'updated', className }: LiveIndicatorProps) {
  const dotTone = tone ?? (variant === 'pill' ? 'acc' : 'ok');
  if (status === 'connecting') return <div aria-live="polite" className={className} />;
  const paused = status !== 'live';
  const shape =
    variant === 'pill'
      ? 'rounded-pill border px-3 py-2 text-[13px]'
      : paused
        ? 'rounded-pill px-2.5 py-1 text-[12.5px]'
        : 'text-[13px] text-fg-3';
  return (
    <div aria-live="polite" className={cn('inline-flex', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-2',
          shape,
          paused ? 'border-transparent bg-warn-bg text-warn' : variant === 'pill' ? 'border-line text-fg' : '',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-[7px] shrink-0 rounded-full',
            paused ? 'bg-warn' : dotTone === 'acc' ? 'animate-pulse-live bg-acc' : 'animate-pulse-ok bg-ok',
          )}
        />
        {paused ? (
          REALTIME_PAUSED_MESSAGE
        ) : (
          <span>
            {text}
            {updatedAt ? (
              <>
                {' · '}
                <RelativeTime value={updatedAt} prefix={updatedPrefix} />
              </>
            ) : null}
          </span>
        )}
      </span>
    </div>
  );
}
