/**
 * Live-updates indicator for realtime screens. Pass the status from `useRealtime()`.
 *
 *   const { status } = useRealtime(['owner.order'], onEvent, { fallbackRefetch: orders.refetch });
 *   <RealtimeStatus status={status} />
 *
 * live -> small green "Live" chip; otherwise a polite notice "Live updates paused — refreshing every 10 s"
 * (HLD §3.3 copy). 'connecting' shows nothing to avoid a flash on page load.
 */
import type { RealtimeStatus as Status } from '../../lib/realtime';
import { REALTIME_PAUSED_MESSAGE } from '../../lib/realtime';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export function RealtimeStatus({ status, className }: { status: Status; className?: string }) {
  return (
    <div aria-live="polite" className={cn('min-h-0', className)}>
      {status === 'live' ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success-700">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success-600 opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-success-600" />
          </span>
          Live
        </span>
      ) : status === 'polling' || status === 'reconnecting' ? (
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-warn-50 px-2.5 py-1 text-xs font-medium text-warn-800 ring-1 ring-inset ring-warn-100">
          <Icon name="refresh" size={14} />
          {REALTIME_PAUSED_MESSAGE}
        </span>
      ) : null}
    </div>
  );
}
