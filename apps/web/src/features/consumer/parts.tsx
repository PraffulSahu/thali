/** Small presentational pieces shared by consumer pages (price breakdowns, ETA labels, demo badges). */
import type { ReactNode } from 'react';
import type { Breakdown } from '@thali/contracts';
import { Badge, Icon, Price } from '../../components/ui';
import { formatDistanceKm, formatMinutes } from '../../lib/format';
import { cn } from '../../lib/cn';
import { etaLabel, isDemoEstimate } from './api';

export function Row({ label, children, strong, tone }: { label: ReactNode; children: ReactNode; strong?: boolean; tone?: 'success' }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-0.5', strong ? 'font-semibold text-slate-900' : 'text-sm text-slate-700')}>
      <dt className={cn(tone === 'success' && 'text-success-800')}>{label}</dt>
      <dd className={cn('tabular-nums', tone === 'success' && 'text-success-800')}>{children}</dd>
    </div>
  );
}

/** Line-by-line breakdown. Zero discounts/fees are hidden; the total row label is configurable. */
export function BreakdownRows({ b, totalLabel = 'Total' }: { b: Breakdown; totalLabel?: string }) {
  const minus = (paise: number) => (
    <span>
      −<Price paise={paise} tone="success" />
    </span>
  );
  return (
    <dl className="divide-y-0">
      <Row label="Items">
        <Price paise={b.itemsSubtotalPaise} />
      </Row>
      {b.couponDiscountPaise > 0 ? (
        <Row label="Coupon discount" tone="success">
          {minus(b.couponDiscountPaise)}
        </Row>
      ) : null}
      {b.membershipDiscountPaise > 0 ? (
        <Row label="Membership discount" tone="success">
          {minus(b.membershipDiscountPaise)}
        </Row>
      ) : null}
      {b.packagingFeePaise > 0 ? (
        <Row label="Packaging">
          <Price paise={b.packagingFeePaise} />
        </Row>
      ) : null}
      <Row label="Delivery fee">
        <Price paise={b.deliveryFeePaise} freeLabel="Free" />
      </Row>
      {b.deliveryDiscountPaise > 0 ? (
        <Row label="Delivery discount" tone="success">
          {minus(b.deliveryDiscountPaise)}
        </Row>
      ) : null}
      {b.platformFeePaise > 0 ? (
        <Row label="Platform fee">
          <Price paise={b.platformFeePaise} />
        </Row>
      ) : null}
      {b.foodTaxPaise + b.feeTaxPaise > 0 ? (
        <Row label="Taxes (GST)">
          <Price paise={b.foodTaxPaise + b.feeTaxPaise} />
        </Row>
      ) : null}
      <div className="mt-1 border-t border-slate-200 pt-1">
        <Row label={totalLabel} strong>
          <Price paise={b.totalPaise} />
        </Row>
      </div>
    </dl>
  );
}

/** "32 min · 2.1 km (demo estimate)" — never presents an estimate as fact. */
export function EtaText({ minutes, distanceKm, source, className }: { minutes?: number | null; distanceKm?: number | null; source?: string | null; className?: string }) {
  if (minutes == null && distanceKm == null) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 text-sm text-slate-600', className)}>
      <Icon name="clock" size={14} />
      {minutes != null ? <span className="tabular-nums">{formatMinutes(minutes)}</span> : null}
      {distanceKm != null ? <span className="tabular-nums">· {formatDistanceKm(distanceKm)}</span> : null}
      <span className={cn(isDemoEstimate(source) && 'font-medium text-info-800')}>({etaLabel(source)})</span>
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
    <p className={cn('flex items-center gap-1.5 text-sm text-slate-600', className)}>
      <Icon name="bike" size={16} className="text-slate-500" />
      {note && /separately/i.test(note) ? note : 'Delivered separately'}
    </p>
  );
}
