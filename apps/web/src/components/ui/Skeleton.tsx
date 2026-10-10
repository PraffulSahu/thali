/**
 * Layout-stable loading placeholders (design-spec §3.31): shimmer from --muted to --bg2, 8px radius. They are
 * decorative (aria-hidden); wrap a loading region in role="status" + aria-busy + sr-only text, or use
 * <QueryState>, which does that for you. Spinners only inside buttons.
 *
 *   <Skeleton className="h-40 w-full" />
 *   <SkeletonText lines={3} />            // 12px lines at 90 / 60 / 75 %
 *   <SkeletonList count={4} />            // generic list of card rows
 *   <SkeletonCard />                      // restaurant card (150px cover + 3 lines)
 *   <SkeletonKpi />  <SkeletonAvatar size={36} />  <SkeletonChip />  <SkeletonTable rows={5} cols={4} />
 */
import { cn } from '../../lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}

const LINE_WIDTHS = ['w-[90%]', 'w-[60%]', 'w-[75%]'];

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', LINE_WIDTHS[i % LINE_WIDTHS.length])} />
      ))}
    </div>
  );
}

export function SkeletonList({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-card border border-line bg-card p-4">
          <Skeleton className="size-12 shrink-0 rounded-control" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Restaurant card placeholder matching <RestaurantCard>. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('overflow-hidden rounded-card border border-line bg-card', className)}>
      <Skeleton className="h-[150px] w-full rounded-none max-sm:h-[140px]" />
      <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3.5">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-[75%]" />
        <Skeleton className="h-3 w-[90%]" />
      </div>
    </div>
  );
}

export function SkeletonKpi({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2', className)}>
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-[26px] w-[60%]" />
    </div>
  );
}

export function SkeletonAvatar({ size = 36, className }: { size?: number; className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton shrink-0 rounded-full!', className)} style={{ width: size, height: size }} />;
}

export function SkeletonChip({ className }: { className?: string }) {
  return <Skeleton className={cn('h-6 w-20 rounded-pill!', className)} />;
}

export function SkeletonTable({ rows = 5, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-4 border-b border-line px-3.5 py-3 last:border-0" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-[80%]' : 'w-[60%]')} />
          ))}
        </div>
      ))}
    </div>
  );
}
