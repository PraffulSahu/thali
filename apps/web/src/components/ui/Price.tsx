/**
 * Money display. Input is always integer paise (LLD §1.1); formatting via `formatINR` from contracts.
 *
 *   <Price paise={24900} />                         ₹249.00
 *   <Price paise={0} freeLabel="Free" />            Free
 *   <Price paise={-5000} tone="success" />          -₹50.00 (discount)
 *   <Price paise={29900} was={34900} />             ₹299.00 with ₹349.00 struck through
 *   <Price paise={total} size="lg" />               emphasized total
 */
import { formatINR } from '@thali/contracts';
import { cn } from '../../lib/cn';

export interface PriceProps {
  paise: number;
  /** Previous price, shown struck through. */
  was?: number;
  /** Label to show instead of ₹0.00. */
  freeLabel?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'default' | 'muted' | 'success' | 'brand';
  className?: string;
}

const sizes = { sm: 'text-sm', md: 'text-[0.9375rem]', lg: 'text-lg font-semibold', xl: 'text-2xl font-bold tracking-tight' };
const tones = { default: 'text-slate-900', muted: 'text-slate-600', success: 'text-success-700', brand: 'text-brand-700' };

/** Safe formatter: never throws on non-integer data (shows a placeholder instead). */
export function formatPaise(paise: number): string {
  return Number.isInteger(paise) ? formatINR(paise) : '₹ -';
}

export function Price({ paise, was, freeLabel, size = 'md', tone = 'default', className }: PriceProps) {
  const text = paise === 0 && freeLabel ? freeLabel : formatPaise(paise);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 tabular-nums', sizes[size], tones[tone], className)}>
      {was !== undefined && was !== paise ? (
        <s className="text-[0.85em] font-normal text-slate-500">
          <span className="sr-only">Was </span>
          {formatPaise(was)}
        </s>
      ) : null}
      <span>
        {was !== undefined && was !== paise ? <span className="sr-only">Now </span> : null}
        {text}
      </span>
    </span>
  );
}
