/**
 * Bill breakdown accordion (design-spec §3.25): "Bill, per restaurant" aside with one expandable group per
 * restaurant, a "To pay" footer and the Pay action. First group open by default. Presentational.
 *
 *   <BillBreakdown
 *     groups={quote.groups.map((g) => ({ id: g.restaurantId, name: g.name, totalPaise: g.totalPaise, rows: [
 *       { label: 'Items', paise: g.itemsPaise },
 *       { label: 'Coupon share', paise: -g.couponPaise, discount: true },
 *       { label: 'Delivery fee', paise: g.deliveryFeePaise }, …] }))}
 *     totalPaise={quote.totalPaise}
 *     action={<Button size="lg" fullWidth onClick={pay} loading={paying}>Pay ₹646.20</Button>}
 *     footnote="You'll be charged once. Each restaurant is refunded separately if it can't deliver."
 *   />
 * Row order (spec): Items · Coupon share · Membership discount share · Packaging · Delivery fee ·
 * Free delivery (−) · Platform fee · GST on food · GST on fees. Discounts render "−₹" in --ok.
 */
import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { Icon } from './Icon';
import { formatPaise } from './Price';

export interface BillRowData {
  label: ReactNode;
  paise: number;
  /** Render as a discount (−₹, --ok). Pass a positive or negative amount. */
  discount?: boolean;
}

export interface BillGroup {
  id: string;
  name: string;
  totalPaise: number;
  rows: BillRowData[];
}

export function BillRow({ label, paise, discount }: BillRowData) {
  return (
    <div className="flex justify-between gap-3 text-[13px]">
      <dt className="text-fg-3">{label}</dt>
      <dd className={cn('tabular-nums', discount ? 'text-ok' : 'text-fg')}>{discount ? `−${formatPaise(Math.abs(paise))}` : formatPaise(paise)}</dd>
    </div>
  );
}

export interface BillBreakdownProps {
  groups: BillGroup[];
  totalPaise: number;
  title?: string;
  action?: ReactNode;
  footnote?: ReactNode;
  /** Ids open initially (default: the first group). */
  defaultOpen?: string[];
  sticky?: boolean;
  className?: string;
}

export function BillBreakdown({ groups, totalPaise, title = 'Bill, per restaurant', action, footnote, defaultOpen, sticky = true, className }: BillBreakdownProps) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultOpen ?? (groups[0] ? [groups[0].id] : [])));
  const base = useId().replace(/:/g, '');
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <aside aria-label={title} className={cn('w-full overflow-hidden rounded-card border border-line bg-card shadow-card lg:max-w-[400px]', sticky && 'lg:sticky lg:top-6', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-[18px]">
        <h2 className="font-sans text-base font-semibold tracking-normal">{title}</h2>
        <span className="rounded-pill bg-acc-soft px-2 py-1 font-mono text-[11px] uppercase text-acc-fg">{plural(groups.length, 'delivery', 'deliveries')}</span>
      </header>
      <div className="divide-y divide-line">
        {groups.map((g) => {
          const isOpen = open.has(g.id);
          const panelId = `bill${base}-${g.id}`;
          return (
            <div key={g.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(g.id)}
                className="flex min-h-[54px] w-full items-center gap-2.5 px-5 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{g.name}</span>
                <span className="text-[14.5px] font-semibold tabular-nums">{formatPaise(g.totalPaise)}</span>
                <Icon name="chevron-down" size={14} className={cn('shrink-0 text-fg-3 transition-transform duration-200', isOpen && 'rotate-180')} />
              </button>
              {isOpen ? (
                <dl id={panelId} className="flex animate-open flex-col gap-2 px-5 pb-3.5">
                  {g.rows.map((r, i) => (
                    <BillRow key={i} {...r} />
                  ))}
                </dl>
              ) : null}
            </div>
          );
        })}
      </div>
      <footer className="flex flex-col gap-3.5 border-t border-line bg-bg-2 px-5 py-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[15px] font-medium">To pay</span>
          <span className="text-[28px] font-semibold tracking-[-0.03em] tabular-nums max-sm:text-2xl">{formatPaise(totalPaise)}</span>
        </div>
        {action}
        {footnote ? <p className="text-xs leading-normal text-fg-3">{footnote}</p> : null}
      </footer>
    </aside>
  );
}
