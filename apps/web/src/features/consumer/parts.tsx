/** Small presentational pieces shared by consumer pages (bill rows, ETA labels, demo badges, empty cart). */
import type { ReactNode } from 'react';
import type { Breakdown } from '@thali/contracts';
import { Badge, BillRow, ButtonLink, EmptyState, EstBadge, Icon, type BillRowData } from '../../components/ui';
import { CuisineArt } from '../../components/illustrations';
import { formatDistanceKm, formatINR } from '../../lib/format';
import { cn } from '../../lib/cn';
import { isDemoEstimate } from './api';

/**
 * Bill rows in the spec order (design-spec §3.25): Items · Coupon share · Membership discount share · Packaging ·
 * Delivery fee · Free delivery (−) · Platform fee · GST on food · GST on fees. Zero discounts/fees are hidden
 * (except the delivery fee, which shows ₹0.00 when waived).
 */
export function billRows(b: Breakdown, opts: { couponLabel?: string } = {}): BillRowData[] {
  const rows: BillRowData[] = [{ label: 'Items', paise: b.itemsSubtotalPaise }];
  if (b.couponDiscountPaise > 0) rows.push({ label: opts.couponLabel ?? 'Coupon share', paise: b.couponDiscountPaise, discount: true });
  if (b.membershipDiscountPaise > 0) rows.push({ label: 'Thali Plus discount', paise: b.membershipDiscountPaise, discount: true });
  if (b.packagingFeePaise > 0) rows.push({ label: 'Packaging', paise: b.packagingFeePaise });
  rows.push({ label: 'Delivery fee', paise: b.deliveryFeePaise });
  if (b.deliveryDiscountPaise > 0) rows.push({ label: 'Free delivery', paise: b.deliveryDiscountPaise, discount: true });
  if (b.platformFeePaise > 0) rows.push({ label: 'Platform fee', paise: b.platformFeePaise });
  if (b.foodTaxPaise > 0) rows.push({ label: 'GST on food', paise: b.foodTaxPaise });
  if (b.feeTaxPaise > 0) rows.push({ label: 'GST on fees', paise: b.feeTaxPaise });
  return rows;
}

/** A `<dl>` of bill rows with a total line (order detail, price-changed dialog). */
export function BillList({ b, totalLabel = 'Total', className }: { b: Breakdown; totalLabel?: string; className?: string }) {
  return (
    <dl className={cn('flex flex-col gap-2', className)}>
      {billRows(b).map((r, i) => (
        <BillRow key={i} {...r} />
      ))}
      <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-[14.5px] font-semibold">
        <dt>{totalLabel}</dt>
        <dd className="tabular-nums">{formatINR(b.totalPaise)}</dd>
      </div>
    </dl>
  );
}

/** "32 min EST. · 2.1 km" — never presents an estimate as fact; "demo estimate" in demo. */
export function EtaText({ minutes, distanceKm, source, className }: { minutes?: number | null; distanceKm?: number | null; source?: string | null; className?: string }) {
  if (minutes == null && distanceKm == null) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-[13px] text-fg-2', className)}>
      <Icon name="clock" size={14} className="text-fg-3" />
      {minutes != null ? (
        <span className="inline-flex items-center gap-1 tabular-nums">
          {minutes} min <EstBadge />
        </span>
      ) : null}
      {distanceKm != null ? <span className="tabular-nums">· {formatDistanceKm(distanceKm)}</span> : null}
      {isDemoEstimate(source) ? <span className="text-fg-3">(demo estimate)</span> : null}
    </span>
  );
}

export function DemoBadge({ show, label = 'Demo' }: { show: boolean | undefined; label?: string }) {
  return show ? (
    <Badge tone="info" icon="info">
      {label}
    </Badge>
  ) : null;
}

export function SeparateDeliveryNote({ note, className }: { note?: string; className?: string }) {
  return (
    <p className={cn('flex items-center gap-1.5 text-[13px] text-fg-3', className)}>
      <Icon name="bike" size={15} />
      {note && /separately/i.test(note) ? note : 'Delivered separately'}
    </p>
  );
}

/** Empty cart (design-spec §7.2): cuisine "all" art + "Your cart is empty" + "Browse restaurants". */
export function EmptyCart({ onBrowse, compact }: { onBrowse?: () => void; compact?: boolean }) {
  return (
    <EmptyState
      compact={compact}
      icon={null}
      illustration={<CuisineArt slug="all" className="size-[72px]" />}
      title="Your cart is empty"
      description="Add dishes from any restaurant that delivers to you. Each restaurant delivers its part separately."
      action={
        <ButtonLink to="/" onClick={onBrowse}>
          Browse restaurants
        </ButtonLink>
      }
    />
  );
}

/** Accent word helper for consumer h1s ("Delivering to <Accent>Home</Accent>"). */
export function Accent({ children }: { children: ReactNode }) {
  return <span className="accent-word">{children}</span>;
}

/** "12 Oct, 7:42 PM" → "today, 7:42 PM" / "yesterday, …" in IST. */
export function relativeDay(iso: string, now = Date.now()): string {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  const day = fmt(new Date(iso));
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).toUpperCase();
  if (day === fmt(new Date(now))) return `today, ${time}`;
  if (day === fmt(new Date(now - 86_400_000))) return `yesterday, ${time}`;
  const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(iso));
  return `${date}, ${time}`;
}

/** IST clock time "7:42 PM". */
export function istTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).toUpperCase();
}
