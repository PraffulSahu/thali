/**
 * Responsive data table: a real <table> on >= 768px, a card list on phones (one card per row: `primary`
 * column as the title, `secondary` under it, the rest as label/value pairs). Built-in loading, error (with
 * retry) and empty states, so pages never render a blank table.
 *
 *   const columns: Column<Order>[] = [
 *     { key: 'code', header: 'Order', cell: (o) => o.code, primary: true },
 *     { key: 'customer', header: 'Customer', cell: (o) => o.customerName, secondary: true },
 *     { key: 'status', header: 'Status', cell: (o) => <StatusPill kind="childOrder" status={o.status} /> },
 *     { key: 'total', header: 'Total', cell: (o) => <Price paise={o.totalPaise} />, align: 'right' },
 *   ];
 *   <DataTable caption="Orders" columns={columns} rows={q.data?.items} getRowId={(o) => o.id}
 *     loading={q.isPending} error={q.error} onRetry={q.refetch}
 *     empty={{ title: 'No orders match these filters', action: <Button onClick={clear}>Clear filters</Button> }}
 *     rowHref={(o) => `/admin/orders/${o.checkoutId}`} rowActions={(o) => <Button size="sm">Assign</Button>}
 *     footer={<Pagination … />} />
 *
 * `rowHref` makes the primary cell a link that stretches over the row (keyboard + screen-reader friendly).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { MQ_DESKTOP, useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { EmptyState, type EmptyStateProps } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Card title on mobile; link target when rowHref is set. Exactly one column should be primary. */
  primary?: boolean;
  /** Shown under the title on mobile cards. */
  secondary?: boolean;
  hideOnMobile?: boolean;
  className?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  getRowId: (row: T) => string;
  /** Accessible table name (visually hidden unless captionVisible). */
  caption: string;
  captionVisible?: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => unknown;
  empty?: Omit<EmptyStateProps, 'compact'>;
  rowHref?: (row: T) => string | undefined;
  rowActions?: (row: T) => ReactNode;
  footer?: ReactNode;
  className?: string;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function DataTable<T>({
  columns, rows, getRowId, caption, captionVisible, loading, error, onRetry, empty, rowHref, rowActions, footer, className,
}: DataTableProps<T>) {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const primary = columns.find((c) => c.primary) ?? columns[0];

  const wrap = (body: ReactNode) => (
    <section aria-label={caption} className={cn('overflow-hidden rounded-field border border-line bg-card', className)}>
      {captionVisible ? <h2 className="border-b border-line px-4 py-3.5 text-[14.5px] text-fg">{caption}</h2> : null}
      {body}
      {footer ? <div className="border-t border-line px-4 pb-4">{footer}</div> : null}
    </section>
  );

  if (loading && !rows) {
    return wrap(
      <div role="status" className="flex flex-col gap-3 p-4">
        <span className="sr-only">Loading {caption.toLowerCase()}…</span>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>,
    );
  }
  if (error && !rows) return wrap(<ErrorState compact error={error} onRetry={onRetry} />);
  if (!rows || rows.length === 0) {
    return wrap(<EmptyState compact as="h3" title={empty?.title ?? 'Nothing here yet'} {...empty} />);
  }

  const cellContent = (c: Column<T>, row: T) => {
    const content = c.cell(row);
    const href = c === primary ? rowHref?.(row) : undefined;
    if (!href) return content;
    return (
      <Link to={href} className="font-medium text-fg after:absolute after:inset-0 after:content-[''] hover:text-acc-fg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-acc focus-visible:after:-outline-offset-2">
        {content}
      </Link>
    );
  };

  if (desktop) {
    return wrap(
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-side backdrop-blur-sm">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('whitespace-nowrap px-3.5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[.06em] text-fg-3', alignClass[c.align ?? 'left'])}>
                  {c.header}
                </th>
              ))}
              {rowActions ? (
                <th scope="col" className="px-3.5 py-2.5 text-right font-mono text-[11px] font-medium uppercase tracking-[.06em] text-fg-3">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={getRowId(row)} className={cn('relative border-b border-line transition-colors duration-[120ms] last:border-0 hover:bg-bg-2', rowHref && 'cursor-pointer')}>
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3.5 py-[11px] align-middle text-fg', alignClass[c.align ?? 'left'], c.align === 'right' && 'tabular-nums', c.className)}>
                    {cellContent(c, row)}
                  </td>
                ))}
                {rowActions ? (
                  <td className="relative z-[1] px-3.5 py-2 text-right">
                    <div className="inline-flex items-center gap-2">{rowActions(row)}</div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  }

  const secondary = columns.filter((c) => c.secondary);
  const rest = columns.filter((c) => c !== primary && !c.secondary && !c.hideOnMobile);
  return wrap(
    <ul className="divide-y divide-line" aria-label={caption}>
      {rows.map((row) => (
        <li key={getRowId(row)} className={cn('relative flex flex-col gap-2 p-4', rowHref && 'active:bg-bg-2')}>
          <div className="text-[15px] text-fg">{primary ? cellContent(primary, row) : null}</div>
          {secondary.map((c) => (
            <div key={c.key} className="-mt-1 text-[13px] text-fg-3">
              {c.cell(row)}
            </div>
          ))}
          {rest.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
              {rest.map((c) => (
                <div key={c.key} className="contents">
                  <dt className="font-mono text-[11px] uppercase tracking-[.06em] text-fg-3">{c.header}</dt>
                  <dd className="text-right text-fg">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {rowActions ? <div className="relative z-[1] flex flex-wrap gap-2 pt-1">{rowActions(row)}</div> : null}
        </li>
      ))}
    </ul>,
  );
}
