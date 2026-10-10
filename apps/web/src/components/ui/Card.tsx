/**
 * Surface container (design-spec: `.card` = 1px --line border, 16px radius, solid --card; hover lift when
 * `interactive`). Use for genuinely separate objects (an order, a restaurant, a form section), not to
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

const pad = { none: '', sm: 'p-3.5', md: 'p-4 sm:px-5 sm:py-[18px]', lg: 'p-5 sm:p-7' };
const tones = {
  default: 'bg-card border-line',
  muted: 'bg-bg-2 border-line',
  brand: 'bg-acc-soft border-line',
  warn: 'bg-warn-bg border-line',
  danger: 'bg-bad-bg border-line',
};

export function Card({ children, as: As = 'div', padding = 'md', interactive, tone = 'default', className, ...rest }: CardProps) {
  return (
    <As
      className={cn(
        'rounded-card border',
        tones[tone],
        pad[padding],
        interactive && 'transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-2 hover:shadow-card',
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
        <H className="text-[15px] leading-tight text-fg">{title}</H>
        {description ? <p className="mt-1 text-[13px] text-fg-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A divided region inside a Card. */
export function CardSection({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-4 border-t border-line pt-4', className)}>{children}</div>;
}
