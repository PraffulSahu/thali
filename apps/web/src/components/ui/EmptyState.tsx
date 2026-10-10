/**
 * Empty results. Say what is empty and what to do next; include an action whenever one exists.
 *
 *   <EmptyState icon="store" title="No restaurants deliver here yet"
 *     description="Try a different address or check back soon."
 *     action={<Button onClick={changeAddress}>Change address</Button>} />
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  /** Compact variant for inside cards / tables. */
  compact?: boolean;
  /** Heading level (default h2). */
  as?: 'h2' | 'h3';
  className?: string;
}

export function EmptyState({ title, description, icon = 'search', action, compact, as: H = 'h2', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14', className)}>
      <span className={cn('grid place-items-center rounded-full bg-brand-50 text-brand-700', compact ? 'size-11' : 'size-14')}>
        <Icon name={icon} size={compact ? 22 : 26} />
      </span>
      <H className={cn('font-semibold text-slate-900', compact ? 'text-base' : 'text-lg')}>{title}</H>
      {description ? <p className="max-w-prose text-[0.9375rem] text-slate-600">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
