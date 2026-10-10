/**
 * Empty results (design-spec §3.32): dashed card, title 600 17px, body 14px --fg3, one outline action.
 * Say what is empty and what to do next; include an action whenever one exists. `compact` drops the frame
 * (inside cards, tables and kanban columns).
 *
 *   <EmptyState icon="store" title="No restaurants deliver here yet"
 *     description="Try a different address or check back soon."
 *     action={<Button variant="outline" onClick={changeAddress}>Change address</Button>} />
 *   <EmptyState illustration={<CuisineArt slug="all" />} title="Your cart is empty" ... />
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** 36px icon tile; pass `null` for none. */
  icon?: IconName | null;
  /** Replaces the icon tile (e.g. a 72px cuisine illustration). */
  illustration?: ReactNode;
  action?: ReactNode;
  /** No frame, tighter spacing (inside cards / tables). */
  compact?: boolean;
  /** Heading level (default h2). */
  as?: 'h2' | 'h3';
  className?: string;
}

export function EmptyState({ title, description, icon = 'search', illustration, action, compact, as: H = 'h2', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 rounded-card border border-dashed border-line-2 bg-card px-6 py-10',
        className,
      )}
    >
      {illustration ? (
        <span aria-hidden="true" className="block size-[72px]">{illustration}</span>
      ) : icon ? (
        <span className="grid size-9 place-items-center rounded-item bg-fill text-fg-3">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <H className="font-sans text-[17px] font-semibold tracking-normal text-fg">{title}</H>
      {description ? <p className="max-w-prose text-sm text-fg-3">{description}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
