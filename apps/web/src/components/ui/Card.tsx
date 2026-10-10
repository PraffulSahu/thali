/**
 * Surface container. Use for genuinely separate objects (an order, a restaurant, a form section), not to
 * wrap every block. Never nest Cards; use <CardSection> dividers inside one Card instead.
 *
 *   <Card>
 *     <CardHeader title="Biryani House" description="2 items" actions={<StatusPill .../>} />
 *     <CardSection>…</CardSection>
 *   </Card>
 *   <Card as="li" interactive>…</Card>   // hover affordance for clickable rows
 */
import type { ElementType, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps {
  children: ReactNode;
  as?: ElementType;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
  tone?: 'default' | 'muted' | 'brand' | 'warn' | 'danger';
  className?: string;
  [attr: `aria-${string}` | `data-${string}`]: string | undefined;
  id?: string;
}

const pad = { none: '', sm: 'p-3', md: 'p-4 sm:p-5', lg: 'p-5 sm:p-7' };
const tones = {
  default: 'bg-surface border-slate-200',
  muted: 'bg-surface-muted border-slate-200',
  brand: 'bg-brand-50 border-brand-200',
  warn: 'bg-warn-50 border-warn-100',
  danger: 'bg-danger-50 border-danger-100',
};

export function Card({ children, as: As = 'div', padding = 'md', interactive, tone = 'default', className, ...rest }: CardProps) {
  return (
    <As
      className={cn(
        'rounded-card border shadow-raised',
        tones[tone],
        pad[padding],
        interactive && 'transition-[border-color,box-shadow] duration-150 hover:border-slate-300 hover:shadow-overlay',
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level for document outline (default h2). */
  as?: 'h2' | 'h3' | 'h4';
  className?: string;
}

export function CardHeader({ title, description, actions, as: H = 'h2', className }: CardHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <H className="text-base font-semibold text-slate-900">{title}</H>
        {description ? <p className="mt-0.5 text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A divided region inside a Card. */
export function CardSection({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-4 border-t border-slate-200 pt-4', className)}>{children}</div>;
}
