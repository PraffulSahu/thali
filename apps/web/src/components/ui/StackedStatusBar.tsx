/**
 * Stacked status bar (design-spec §3.19, overrides: five groups + "Failed" only when > 0).
 *
 *   <StackedStatusBar title="Child orders by status" segments={[
 *     { key: 'delivered', label: 'Delivered', count: 38, tone: 'ok' },
 *     { key: 'progress', label: 'In progress', count: 7, tone: 'acc' },
 *     { key: 'placed', label: 'Placed', count: 2, tone: 'info' },
 *     { key: 'rejected', label: 'Rejected', count: 3, tone: 'bad' },
 *     { key: 'cancelled', label: 'Cancelled', count: 1, tone: 'neu' },
 *     { key: 'failed', label: 'Failed', count: failed, tone: 'neu', hideWhenZero: true },
 *   ]} />
 * Zero-count segments are omitted from the bar; the legend keeps them (with 0) unless `hideWhenZero`.
 */
import { cn } from '../../lib/cn';

export interface StatusSegment {
  key: string;
  label: string;
  count: number;
  tone: 'ok' | 'acc' | 'info' | 'bad' | 'neu' | 'warn';
  hideWhenZero?: boolean;
}

const fill: Record<StatusSegment['tone'], string> = { ok: 'bg-ok', acc: 'bg-acc', info: 'bg-info', bad: 'bg-bad', neu: 'bg-neu', warn: 'bg-warn' };

export function StackedStatusBar({ title, segments, total, className }: { title: string; segments: StatusSegment[]; total?: number; className?: string }) {
  const legend = segments.filter((s) => !(s.hideWhenZero && s.count === 0));
  const sum = total ?? segments.reduce((n, s) => n + s.count, 0);
  const aria = `${title}: ${legend.map((s) => `${s.label} ${s.count}`).join(', ')}`;
  return (
    <section aria-label={title} className={cn('flex flex-col gap-3 rounded-field border border-line bg-card px-[18px] py-4', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-sans text-sm font-medium tracking-normal text-fg">{title}</h2>
        <span className="font-mono text-xs text-fg-3">{sum}</span>
      </div>
      <div role="img" aria-label={aria} className="flex h-2.5 origin-left animate-grow gap-[3px]">
        {sum === 0 ? <span className="flex-1 rounded-[3px] bg-fill" /> : null}
        {segments.filter((s) => s.count > 0).map((s) => (
          <span key={s.key} className={cn('rounded-[3px]', fill[s.tone])} style={{ flex: s.count }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] text-fg-3" aria-hidden="true">
        {legend.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2 rounded-[2px]', fill[s.tone])} />
            {s.label} {s.count}
          </li>
        ))}
      </ul>
    </section>
  );
}
