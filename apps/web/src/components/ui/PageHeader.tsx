/**
 * Page title block (design-spec §7.1): Bricolage 800 h1 (put an accent word in <AccentWord>), the page's single <h1>, optional back link, description, status and actions.
 * Also sets document.title ("<title> · Thali").
 *
 *   <PageHeader title="Orders" description="Live orders for Biryani House" actions={<Button icon="plus">New item</Button>} />
 *   <PageHeader title={`Order ${order.code}`} back={{ to: '/orders', label: 'All orders' }} status={<StatusPill kind="checkout" status={order.status} />} />
 */
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface PageHeaderProps {
  title: ReactNode;
  /** Plain-text title for document.title when `title` is not a string. */
  documentTitle?: string;
  description?: ReactNode;
  back?: { to: string; label: string };
  status?: ReactNode;
  actions?: ReactNode;
  /** Live indicator / meta row under the title ("Sun, 11 Oct · IST · refreshed 14s ago"). */
  meta?: ReactNode;
  /** shell = role shells 26–28px (default) · page = consumer pages 34px. */
  size?: 'shell' | 'page';
  className?: string;
}

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} · Thali`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

export function PageHeader({ title, documentTitle, description, back, status, actions, meta, size = 'shell', className }: PageHeaderProps) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className={cn('mb-6 flex flex-col gap-3', className)}>
      {back ? (
        <Link
          to={back.to}
          className="-ml-1 inline-flex min-h-9 w-fit items-center gap-1 rounded-control px-1 text-[13px] text-fg-3 hover:text-fg [@media(pointer:coarse)]:min-h-touch"
        >
          <Icon name="chevron-left" size={18} />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className={cn('leading-tight text-fg', size === 'page' ? 'text-[28px] sm:text-[34px] sm:leading-[1.05]' : 'text-2xl sm:text-[28px]')}>{title}</h1>
            {status}
          </div>
          {description ? <p className="mt-1.5 max-w-prose text-[15px] text-fg-3">{description}</p> : null}
          {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-3">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
