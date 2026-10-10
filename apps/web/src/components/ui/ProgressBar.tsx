/**
 * Progress bar (design-spec §3.17): 6px --muted track, --acc fill (--bad when overdue), meta row below.
 *
 *   <ProgressBar value={13} max={20} label="Preparation" left="13 of 20 min" right="Finding partner" />
 *   <ProgressBar value={24} max={20} overdue left="4 min over" label="Preparation" />
 *   <ProgressBar value={3} max={5} label="Free deliveries used" />     // membership, uploads
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Accessible name. */
  label: string;
  left?: ReactNode;
  right?: ReactNode;
  overdue?: boolean;
  tone?: 'acc' | 'ok' | 'info';
  className?: string;
}

export function ProgressBar({ value, max, label, left, right, overdue, tone = 'acc', className }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill = overdue ? 'bg-bad' : tone === 'ok' ? 'bg-ok' : tone === 'info' ? 'bg-info' : 'bg-acc';
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={typeof left === 'string' ? left : undefined}
        className="h-1.5 overflow-hidden rounded-[3px] bg-fill"
      >
        <div className={cn('h-1.5 rounded-[3px] transition-[width] duration-500', fill)} style={{ width: `${pct}%` }} />
      </div>
      {left || right ? (
        <div className="flex justify-between gap-3 text-xs text-fg-3">
          <span className={cn(overdue && 'font-medium text-bad')}>{left}</span>
          <span>{right}</span>
        </div>
      ) : null}
    </div>
  );
}
