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
  /** sm 13px · md 14.5px · lg 600 16px · xl 600 22px · total 600 28px (checkout "To pay"). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'total';
  /** success/ok = discounts (−₹), info = pending refunds, brand/acc = accent text. */
  tone?: 'default' | 'muted' | 'success' | 'brand' | 'ok' | 'info' | 'acc' | 'bad';
  className?: string;
}

const sizes = {
  sm: 'text-[13px]',
  md: 'text-[14.5px]',
  lg: 'text-base font-semibold',
  xl: 'text-[22px] font-semibold tracking-[-0.02em]',
  total: 'text-[28px] font-semibold tracking-[-0.03em] max-sm:text-2xl',
};
const tones = {
  default: 'text-fg',
  muted: 'text-fg-3',
  success: 'text-ok',
  ok: 'text-ok',
  info: 'text-info',
  brand: 'text-acc-fg',
  acc: 'text-acc-fg',
  bad: 'text-bad',
};

/** Safe formatter: never throws on non-integer data (shows a placeholder instead). */
export function formatPaise(paise: number): string {
  return Number.isInteger(paise) ? formatINR(paise) : '₹ -';
}

export function Price({ paise, was, freeLabel, size = 'md', tone = 'default', className }: PriceProps) {
  const text = paise === 0 && freeLabel ? freeLabel : formatPaise(paise);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 tabular-nums', sizes[size], tones[tone], className)}>
      {was !== undefined && was !== paise ? (
        <s className="text-[0.85em] font-normal text-fg-3">
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
