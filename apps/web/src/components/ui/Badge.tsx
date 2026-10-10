/**
 * Chip / badge (design-spec §3.9): pill, bold, leading dot optional. Tones follow the one-colour-one-meaning
 * rule: chili (acc) = in the kitchen / needs your action, sky (info) = moving or waiting on someone else,
 * turmeric (warn) = needs attention / money pending, leaf (ok) = done, red (bad) = failed, grey (neu) = ended.
 *
 *   <Badge tone="acc">New</Badge>  <Badge tone="warn" icon="clock">Closing soon</Badge>
 *   <Badge tone="info" variant="solid">DEMO</Badge>   <Badge tone="ok" dot density="dense">Up</Badge>
 *
 * Tone names: spec names `ok · warn · bad · info · acc · neu` or the legacy `success · warn · danger · info ·
 * brand · neutral` (same colours).
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export type Tone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'info';
export type SpecTone = 'ok' | 'warn' | 'bad' | 'info' | 'acc' | 'neu';
export type AnyTone = Tone | SpecTone;
export type Density = 'marketing' | 'app' | 'dense';

const SPEC: Record<AnyTone, SpecTone> = {
  neutral: 'neu', brand: 'acc', success: 'ok', warn: 'warn', danger: 'bad', info: 'info',
  ok: 'ok', bad: 'bad', acc: 'acc', neu: 'neu',
};

/** Spec tone for any tone name. */
export function specTone(t: AnyTone): SpecTone {
  return SPEC[t];
}

export const toneClasses: Record<SpecTone, { soft: string; solid: string; text: string; bg: string; dot: string }> = {
  ok: { soft: 'bg-ok-bg text-ok', solid: 'bg-ok text-bg', text: 'text-ok', bg: 'bg-ok-bg', dot: 'bg-ok' },
  warn: { soft: 'bg-warn-bg text-warn', solid: 'bg-warn text-bg', text: 'text-warn', bg: 'bg-warn-bg', dot: 'bg-warn' },
  bad: { soft: 'bg-bad-bg text-bad', solid: 'bg-bad text-bg', text: 'text-bad', bg: 'bg-bad-bg', dot: 'bg-bad' },
  info: { soft: 'bg-info-bg text-info', solid: 'bg-info text-bg', text: 'text-info', bg: 'bg-info-bg', dot: 'bg-info' },
  acc: { soft: 'bg-acc-soft text-acc-fg', solid: 'bg-pri text-pri-fg', text: 'text-acc-fg', bg: 'bg-acc-soft', dot: 'bg-acc' },
  neu: { soft: 'bg-fill text-fg-3', solid: 'bg-fg-2 text-bg', text: 'text-fg-3', bg: 'bg-fill', dot: 'bg-neu' },
};

const densities: Record<Density, { box: string; dot: string }> = {
  marketing: { box: 'h-7 px-[11px] text-[13px] gap-1.5', dot: 'size-[7px]' },
  app: { box: 'h-6 px-[9px] text-xs gap-1.5', dot: 'size-1.5' },
  dense: { box: 'h-[22px] px-2 text-[11.5px] gap-1.5', dot: 'size-1.5' },
};

export interface BadgeProps {
  children: ReactNode;
  tone?: AnyTone;
  variant?: 'soft' | 'solid';
  icon?: IconName;
  /** Leading status dot in currentColor (used by StatusPill). */
  dot?: boolean;
  density?: Density;
  className?: string;
}

export function Badge({ children, tone = 'neutral', variant = 'soft', icon, dot, density = 'app', className }: BadgeProps) {
  const t = toneClasses[SPEC[tone]];
  const d = densities[density];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-pill font-bold leading-none',
        d.box,
        variant === 'solid' ? t.solid : t.soft,
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cn('shrink-0 rounded-full bg-current', d.dot)} /> : null}
      {icon ? <Icon name={icon} size={density === 'marketing' ? 14 : 13} /> : null}
      {children}
    </span>
  );
}
