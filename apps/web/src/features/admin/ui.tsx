/**
 * Admin-local design-system pieces (board 40, design-spec §3.30 / §7.5 dense tier). Kept inside the admin
 * area; candidates for the foundation are listed in task-12-report "Foundation gaps".
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Icon } from '../../components/ui/Icon';
import { formatPaise } from '../../components/ui/Price';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusPill } from '../../components/ui/StatusPill';
import { Badge } from '../../components/ui/Badge';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { formatDate, formatTime } from '../../lib/format';
import { istDateToIso, type AdminCheckoutRow } from './api';

/* ------------------------------------------------------------------ time */

/** Re-renders every `ms` (default 1 s) and returns Date.now(); drives "refreshed 14s ago". */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "14s ago" · "3 min ago" · "2 h ago" (never negative). */
export function agoLabel(at: number | string | null | undefined, now: number): string {
  if (at === null || at === undefined || at === 0) return '';
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** Whole minutes since an instant ("6 min", "1 h 4 min"). */
export function ageLabel(at: string | null | undefined, now: number): string {
  if (!at) return '';
  const min = Math.max(0, Math.floor((now - new Date(at).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Today's IST calendar date ("2026-10-11"). */
export function istToday(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

export type DateRange = 'today' | 'yesterday' | '7d' | 'all';
export const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'all', label: 'Any time' },
];

/** IST day window for the recent-orders filter (`from` inclusive, `to` inclusive end of day). */
export function rangeToIso(range: DateRange, now = Date.now()): { from?: string; to?: string } {
  if (range === 'all') return {};
  const day = (offsetDays: number) => istToday(now - offsetDays * 86_400_000);
  if (range === 'today') return { from: istDateToIso(day(0), 'start') };
  if (range === 'yesterday') return { from: istDateToIso(day(1), 'start'), to: istDateToIso(day(1), 'end') };
  return { from: istDateToIso(day(6), 'start') };
}

/** "Sun, 11 Oct" in IST. */
export function istDayLabel(now = Date.now()): string {
  return formatDate(now, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------------ controls */

// Promoted to the foundation (task FP); re-exported so admin imports keep working.
export { FilterPills, PillSelect, type PillSelectProps } from '../../components/ui/FilterPill';

/** Visible explanation for a control the admin's sub-role can't use (gap-analysis §6 "gating with explanations"). */
export function RoleNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] text-fg-3', className)}>
      <Icon name="lock" size={12} />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ checkouts table (board 40 recent orders, /admin/orders) */

/** "Prafful · ••3210" from the checkout customer snapshot (first name + masked last 4). */
export function customerLabel(c: AdminCheckoutRow['customer']): string {
  if (!c) return '—';
  const first = c.name?.trim().split(/\s+/)[0] ?? '';
  const digits = (c.phoneMasked ?? '').replace(/\D/g, '');
  const last4 = digits.length >= 4 ? `••${digits.slice(-4)}` : '';
  return [first, last4].filter(Boolean).join(' · ') || '—';
}

/** Checkout status cell: the attention state wins where it is the operational truth (board 40 "Finding a partner"). */
export function CheckoutStatusCell({ row }: { row: AdminCheckoutRow }) {
  if (row.attention === 'FINDING_PARTNER') return <StatusPill kind="delivery" status="PENDING_ASSIGNMENT" density="dense" />;
  if (row.attention === 'DELIVERY_FAILED') return <StatusPill kind="childOrder" status="DELIVERY_FAILED" density="dense" />;
  if (row.attention === 'REFUND_FAILED') return <StatusPill kind="refund" status="FAILED" density="dense" />;
  return <StatusPill kind="checkout" status={row.status} density="dense" />;
}

/** Refund cell: pending (info) › refunded (ok) › "—". */
export function RefundCell({ row }: { row: AdminCheckoutRow }) {
  if (row.refundPendingPaise > 0) return <span className="text-info">{formatPaise(row.refundPendingPaise)} pending</span>;
  if (row.refundedPaise > 0) return <span className="text-ok">{formatPaise(row.refundedPaise)} refunded</span>;
  return <span className="text-fg-3">—</span>;
}

function placedLabel(row: AdminCheckoutRow, showDate: boolean): string {
  const at = row.placedAt ?? row.createdAt;
  if (!at) return '—';
  return showDate ? `${formatDate(at, { day: 'numeric', month: 'short' })}, ${formatTime(at)}` : formatTime(at);
}

export interface CheckoutsTableProps {
  rows: AdminCheckoutRow[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: { title: string; description?: string; action?: ReactNode };
  caption: string;
  /** Prefix the date in the Placed column (lists spanning several days). */
  showDate?: boolean;
  skeletonRows?: number;
}

const TH = 'whitespace-nowrap border-b border-line bg-side px-3.5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[.06em] text-fg-3';
const TD = 'whitespace-nowrap border-b border-line px-3.5 py-[11px] align-middle text-[13.5px] text-fg';

/** Dense checkout table without its own card (sits inside a SectionCard); ≤640px rows become cards. */
export function CheckoutsTable({ rows, loading, error, onRetry, empty, caption, showDate, skeletonRows = 5 }: CheckoutsTableProps) {
  const wide = useMediaQuery('(min-width: 641px)');
  if (loading && !rows) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2.5 p-4">
        <span className="sr-only">Loading {caption.toLowerCase()}…</span>
        {Array.from({ length: skeletonRows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (error && !rows) return <ErrorState compact error={error} onRetry={onRetry} title={`Couldn't load ${caption.toLowerCase()}`} className="border-0" />;
  if (!rows || rows.length === 0) return <EmptyState compact as="h3" icon="receipt" title={empty.title} description={empty.description} action={empty.action} className="border-0" />;

  if (!wide) {
    return (
      <ul aria-label={caption} className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="relative flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <Link to={`/admin/orders/${r.id}`} className="font-mono text-[13.5px] font-semibold text-fg after:absolute after:inset-0 after:content-['']">
                {r.code}
              </Link>
              <CheckoutStatusCell row={r} />
            </div>
            <p className="text-[13px] text-fg-3">
              {customerLabel(r.customer)} · {r.restaurants.map((x) => x.name).join(', ') || '—'}
            </p>
            <p className="flex items-center justify-between gap-3 text-[13px]">
              <span className="tabular-nums text-fg">{formatPaise(r.paidPaise)}</span>
              <RefundCell row={r} />
              <span className="text-fg-3">{placedLabel(r, Boolean(showDate))}</span>
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(TH, 'text-left')}>Order</th>
            <th scope="col" className={cn(TH, 'text-left')}>Customer</th>
            <th scope="col" className={cn(TH, 'text-left')}>Restaurants</th>
            <th scope="col" className={cn(TH, 'text-left')}>Status</th>
            <th scope="col" className={cn(TH, 'text-right')}>Paid</th>
            <th scope="col" className={cn(TH, 'text-right')}>Refund</th>
            <th scope="col" className={cn(TH, 'text-left')}>Placed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="relative transition-colors duration-[120ms] last:[&>td]:border-0 hover:bg-bg-2">
              <td className={cn(TD, 'font-mono')}>
                <Link
                  to={`/admin/orders/${r.id}`}
                  className="text-fg after:absolute after:inset-0 after:content-[''] hover:text-acc-fg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-acc"
                >
                  {r.code}
                </Link>
              </td>
              <td className={TD}>{customerLabel(r.customer)}</td>
              <td className={cn(TD, 'max-w-[280px] truncate')}>{r.restaurants.map((x) => x.name).join(', ') || '—'}</td>
              <td className={TD}>
                <CheckoutStatusCell row={r} />
              </td>
              <td className={cn(TD, 'text-right tabular-nums')}>{formatPaise(r.paidPaise)}</td>
              <td className={cn(TD, 'text-right tabular-nums')}>
                <RefundCell row={r} />
              </td>
              <td className={cn(TD, 'text-fg-3')}>{placedLabel(r, Boolean(showDate))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const CHECKOUT_STATUS_OPTIONS: { value: string; label: string }[] = [
  // ORD-1 lists never-placed checkouts (awaiting payment / payment failed / expired) only when asked by status.
  { value: 'ALL', label: 'All placed' },
  { value: 'PAID_PLACED', label: 'Order placed' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'PARTIALLY_COMPLETED', label: 'Partially completed' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'AWAITING_PAYMENT', label: 'Awaiting payment' },
  { value: 'PAYMENT_FAILED', label: 'Payment failed' },
  { value: 'EXPIRED', label: 'Expired' },
];

/** Neutral "DEMO" pill for demo-only controls and demo records. */
export function DemoTag({ children = 'DEMO' }: { children?: ReactNode }) {
  return (
    <Badge tone="info" variant="solid" density="dense" className="font-mono tracking-[.04em]">
      {children}
    </Badge>
  );
}

/* ------------------------------------------------------------------ detail pages (design-spec §7.1 two columns) */

export { DetailColumns, HistoryTimeline } from '../../components/ui/HistoryTimeline';


/** Document rows inside a SectionCard (label, uploaded time, chips, actions). */
export function DocRow({ title, sub, chips, actions }: { title: ReactNode; sub: ReactNode; chips?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-fg">{title}</span>
        <span className="block text-[12.5px] text-fg-3">{sub}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {chips}
        {actions}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ health text (shared by overview + Health page) */

/** Row text: down → the real error (unreachable), degraded → its reasons, up → summary. */
export function serviceHealthText(s: { status: 'up' | 'degraded' | 'down'; error?: string; summary?: string; degradedReasons?: string[] }): string {
  if (s.status === 'down') return s.error ?? s.summary ?? 'No response from this service.';
  if (s.status === 'degraded') return s.degradedReasons?.length ? s.degradedReasons.join('; ') : s.summary ?? 'Degraded';
  return s.summary ?? '—';
}

/** Tone for the health text cell: problems in mono + tone colour, healthy rows muted. */
export const HEALTH_TEXT_TONE = { up: 'text-fg-3', degraded: 'font-mono text-[12px] text-warn', down: 'font-mono text-[12px] text-bad' } as const;
