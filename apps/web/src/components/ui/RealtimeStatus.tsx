/**
 * Live-updates indicator for realtime screens (kept for existing screens; new code: <LiveIndicator>).
 *
 *   const { status } = useRealtime(['owner.order'], onEvent, { fallbackRefetch: orders.refetch });
 *   <RealtimeStatus status={status} />
 *
 * live -> pulsing --ok dot + "Live"; polling/reconnecting -> "Live updates paused — refreshing every 10 s"
 * (HLD §3.3 copy); connecting shows nothing to avoid a flash on page load.
 */
import type { RealtimeStatus as Status } from '../../lib/realtime';
import { LiveIndicator } from './LiveIndicator';

export function RealtimeStatus({ status, className }: { status: Status; className?: string }) {
  return <LiveIndicator status={status} variant="inline" className={className} />;
}
