/**
 * Small inline label. Tones map to the semantic palette; text always meets AA on its tint.
 *
 *   <Badge tone="brand">New</Badge>  <Badge tone="warn" icon="clock">Closing soon</Badge>
 *   <Badge tone="info" variant="solid">DEMO</Badge>
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export type Tone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'info';

export const toneClasses: Record<Tone, { soft: string; solid: string; dot: string }> = {
  neutral: { soft: 'bg-slate-100 text-slate-700 ring-slate-200', solid: 'bg-slate-700 text-white ring-slate-700', dot: 'bg-slate-500' },
  brand: { soft: 'bg-brand-50 text-brand-800 ring-brand-200', solid: 'bg-brand-600 text-white ring-brand-600', dot: 'bg-brand-500' },
  success: { soft: 'bg-success-50 text-success-800 ring-success-100', solid: 'bg-success-700 text-white ring-success-700', dot: 'bg-success-600' },
  warn: { soft: 'bg-warn-50 text-warn-800 ring-warn-100', solid: 'bg-warn-700 text-white ring-warn-700', dot: 'bg-warn-600' },
  danger: { soft: 'bg-danger-50 text-danger-800 ring-danger-100', solid: 'bg-danger-700 text-white ring-danger-700', dot: 'bg-danger-600' },
  info: { soft: 'bg-info-50 text-info-800 ring-info-100', solid: 'bg-info-700 text-white ring-info-700', dot: 'bg-info-600' },
};

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  variant?: 'soft' | 'solid';
  icon?: IconName;
  /** Leading status dot (used by StatusPill). */
  dot?: boolean;
  className?: string;
}

export function Badge({ children, tone = 'neutral', variant = 'soft', icon, dot, className }: BadgeProps) {
  const t = toneClasses[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        variant === 'solid' ? t.solid : t.soft,
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cn('size-1.5 rounded-full', variant === 'solid' ? 'bg-white' : t.dot)} /> : null}
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}
