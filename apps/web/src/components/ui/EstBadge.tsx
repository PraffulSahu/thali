/**
 * `EST.` badge (design-spec §3.11) — the honest-data label for estimates. Place it right after the time.
 *
 *   32 min <EstBadge />                       // inline (10.5px mono, --warn-bg / --warn)
 *   <EstBadge variant="marketing">ESTIMATE</EstBadge>
 *   <EstLegend demo={item.isDemoEstimate} />  // "EST. times are demo estimates" (one per page)
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const variants = {
  inline: 'text-[10.5px] px-1.5 py-0.5 rounded-tag',
  legend: 'text-[10.5px] px-1.5 py-[3px] rounded-tag',
  stat: 'text-[10px] px-[5px] py-0.5 rounded-[4px]',
  marketing: 'text-[11px] px-[7px] py-1 rounded-xs',
};

export function EstBadge({ variant = 'inline', children = 'EST.', className }: { variant?: keyof typeof variants; children?: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center bg-warn-bg font-mono font-medium leading-none text-warn', variants[variant], className)}>
      {children === 'EST.' ? (
        <>
          <span aria-hidden="true">EST.</span>
          <span className="sr-only">estimate</span>
        </>
      ) : (
        children
      )}
    </span>
  );
}

export function EstLegend({ demo, className }: { demo?: boolean; className?: string }) {
  return (
    <p className={cn('inline-flex items-center gap-2 text-[12.5px] text-fg-3', className)}>
      <EstBadge variant="legend">
        <span aria-hidden="true">EST.</span>
      </EstBadge>
      <span>
        <span className="sr-only">EST. </span>times are {demo ? 'demo estimates' : 'estimates'}
      </span>
    </p>
  );
}
