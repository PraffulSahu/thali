/**
 * Detail-page layout + status history (design-spec §7.1, promoted from the admin area).
 *
 *   <DetailColumns main={<SectionCard …/>} aside={<SectionCard …/>} />       // main flex 560 + aside 320–380, wraps
 *   <HistoryTimeline items={[{ title: 'Approved', at: iso, detail: 'Docs verified' }, …]} label="Status history" />
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatDate, formatTime } from '../../lib/format';

/** Main `flex:999 1 560px` + aside `flex:1 1 320px; max-width:380px`, wrapping to one column. */
export function DetailColumns({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-[18px]">{main}</div>
      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-[18px] lg:max-w-[380px]">{aside}</aside>
    </div>
  );
}

/** Vertical status-history list (newest first): "Awaiting approval → Approved · 11 Oct, 7:42 pm · reason". */
export function HistoryTimeline({ items, label = 'Status history' }: { items: { title: ReactNode; at: string | null; detail?: ReactNode }[]; label?: string }) {
  if (items.length === 0) return <p className="text-[13px] text-fg-3">No changes recorded.</p>;
  return (
    <ol aria-label={label} className="flex flex-col">
      {items.map((h, i) => (
        <li key={i} className="relative grid grid-cols-[14px_1fr] gap-x-2.5 pb-3.5 last:pb-0">
          <span aria-hidden="true" className="relative flex justify-center">
            <span className={cn('mt-1.5 size-2 rounded-full', i === 0 ? 'bg-acc' : 'bg-line-2')} />
            {i < items.length - 1 ? <span className="absolute bottom-[-14px] top-4 w-px bg-line" /> : null}
          </span>
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium text-fg">{h.title}</span>
            <span className="block text-[12px] text-fg-3">{h.at ? `${formatDate(h.at, { day: 'numeric', month: 'short', year: 'numeric' })}, ${formatTime(h.at)}` : '—'}</span>
            {h.detail ? <span className="mt-0.5 block break-words text-[12.5px] text-fg-2">{h.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
