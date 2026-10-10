/**
 * Kanban column (design-spec §3.26): labelled section, header "New 1", stacked cards, dashed empty box.
 *
 *   <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-3.5">
 *     <KanbanColumn title="New" count={newOrders.length} empty={{ title: 'No new orders', sub: 'New orders appear here with a chime.' }}>
 *       {newOrders.map((o) => <OrderCard key={o.id} … />)}
 *     </KanbanColumn>
 *   </div>
 *   <KanbanEmpty title="Auto-rejected — the accept window passed" />     // ended-card placeholder
 */
import { Children, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function KanbanEmpty({ title, sub, className }: { title: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex animate-slidein flex-col gap-1.5 rounded-card border border-dashed border-line-2 px-[18px] py-7 text-center', className)}>
      <p className="text-[14.5px] font-medium text-fg">{title}</p>
      {sub ? <p className="text-[13px] text-fg-3">{sub}</p> : null}
    </div>
  );
}

export interface KanbanColumnProps {
  title: string;
  count?: number;
  children?: ReactNode;
  empty?: { title: ReactNode; sub?: ReactNode };
  /** aria-live for new arrivals (New column: 'assertive'). */
  live?: 'polite' | 'assertive';
  className?: string;
}

export function KanbanColumn({ title, count, children, empty, live, className }: KanbanColumnProps) {
  const hasChildren = Children.toArray(children).length > 0;
  return (
    <section aria-label={count !== undefined ? `${title}, ${count}` : title} className={cn('flex min-w-0 flex-col gap-2.5', className)}>
      <h2 className="flex items-baseline gap-2 font-sans text-[15px] font-semibold tracking-normal text-fg">
        {title}
        {count !== undefined ? <span className="font-mono text-xs font-normal text-fg-3">{count}</span> : null}
      </h2>
      <div aria-live={live} className="flex flex-col gap-2.5">
        {hasChildren ? children : empty ? <KanbanEmpty title={empty.title} sub={empty.sub} /> : null}
      </div>
    </section>
  );
}
