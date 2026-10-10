/**
 * Live relative timestamp, re-rendered every second: "updated 12s ago". Hover/long-press shows the full IST
 * time; screen readers get the <time> element. Pair with `staleAfterSec` for tracking freshness.
 *
 *   <RelativeTime value={tracking.lastLocationAt} prefix="updated" staleAfterSec={60} />
 *   -> "updated 12s ago"   (turns warn-coloured with "(stale)" after 60 s)
 */
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';

export interface RelativeTimeProps {
  value: string | number | Date | null | undefined;
  prefix?: string;
  /** Shown when value is empty. */
  fallback?: string;
  staleAfterSec?: number;
  className?: string;
}

export function RelativeTime({ value, prefix, fallback = '', staleAfterSec, className }: RelativeTimeProps) {
  const now = useNow(1000);
  if (value === null || value === undefined || value === '') return fallback ? <span className={className}>{fallback}</span> : null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback ? <span className={className}>{fallback}</span> : null;
  const stale = staleAfterSec !== undefined && now - date.getTime() > staleAfterSec * 1000;
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDateTime(date)}
      className={cn('tabular-nums', stale && 'font-medium text-warn-700', className)}
    >
      {prefix ? `${prefix} ` : ''}
      {formatRelative(date, now)}
      {stale ? ' (stale)' : ''}
    </time>
  );
}
