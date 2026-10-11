/**
 * Small restaurant-area building block: a label / value definition row. (Popover and the bell-off glyph moved to the
 * foundation: components/ui/Popover, <Icon name="bell-off" />.)
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Label / value row for money and detail panels (design-spec §7.1 money panels). */
export function DefRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm', className)}>
      <dt className="text-fg-3">{label}</dt>
      <dd className="text-right text-fg tabular-nums">{children}</dd>
    </div>
  );
}
