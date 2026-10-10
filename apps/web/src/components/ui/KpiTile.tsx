/**
 * KPI tiles (design-spec §3.18). Never show zeros for unavailable stats: pass `unavailable` (+ onRetry).
 *
 *   <KpiTile label="Orders today" value="18" />                                  // standalone card (owner)
 *   <KpiTile label="Revenue · gross / net" value="₹9,842" secondary="/ ₹8,151" />
 *   <KpiStrip>                                                                    // admin strip (one card)
 *     <KpiTile label="Orders" value="42" sub="51 child orders" />
 *     <KpiTile label="Unassigned" value="1" highlight sub={<Link to="/admin/tms">Open deliveries →</Link>} />
 *     <KpiTile label="Failed refunds" value="0" sub="Nothing to retry" subTone="ok" />
 *     <KpiTile label="GMV" unavailable onRetry={refetch} />
 *   </KpiStrip>
 */
import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Skeleton } from './Skeleton';

export interface KpiTileProps {
  label: ReactNode;
  value?: ReactNode;
  secondary?: ReactNode;
  sub?: ReactNode;
  subTone?: 'muted' | 'ok' | 'acc';
  highlight?: boolean;
  loading?: boolean;
  unavailable?: boolean;
  onRetry?: () => void;
  /** Inside a <KpiStrip> (no own card). Set automatically by KpiStrip. */
  inStrip?: boolean;
  className?: string;
}

export function KpiTile({ label, value, secondary, sub, subTone = 'muted', highlight, loading, unavailable, onRetry, inStrip, className }: KpiTileProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2',
        inStrip ? 'px-[18px] py-4' : 'rounded-card border border-line bg-card px-4 py-3.5',
        highlight && 'bg-acc-soft',
        className,
      )}
    >
      <span className={cn('lbl', inStrip && 'text-[11px]!', highlight && 'text-acc-fg!')}>{label}</span>
      {loading ? (
        <Skeleton className="h-[26px] w-[60%]" />
      ) : unavailable ? (
        <span className="text-[26px] font-semibold leading-none text-fg-3 max-sm:text-[22px]">—</span>
      ) : (
        <span className={cn('text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums max-sm:text-[22px]', highlight ? 'text-acc-fg' : 'text-fg')}>
          {value}
          {secondary ? <span className="ml-1 text-base font-normal tracking-normal text-fg-3">{secondary}</span> : null}
        </span>
      )}
      {unavailable ? (
        <span className="text-xs text-fg-3">
          Stats unavailable
          {onRetry ? (
            <>
              {' · '}
              <button type="button" onClick={onRetry} className="font-semibold text-fg underline underline-offset-2">
                Retry
              </button>
            </>
          ) : null}
        </span>
      ) : sub ? (
        <span className={cn('text-xs', subTone === 'ok' ? 'text-ok' : subTone === 'acc' || highlight ? 'text-acc-fg [&_a]:underline' : 'text-fg-3')}>{sub}</span>
      ) : null}
    </div>
  );
}

/** Admin KPI strip: one card, auto-fit columns ≥150px, hairline dividers between cells. */
export function KpiStrip({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <section aria-label={label} className={cn('overflow-hidden rounded-field border border-line bg-card', className)}>
      <div className="-mb-px -mr-px grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] [&>*]:border-b [&>*]:border-r [&>*]:border-line">
        {Children.map(children, (child) => (isValidElement<KpiTileProps>(child) ? cloneElement(child, { inStrip: true }) : child))}
      </div>
    </section>
  );
}
