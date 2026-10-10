/**
 * Notices and section cards (design-spec §3.35, §7.1).
 *
 *   <InfoNotice tone="warn">Keep Thali open while delivering …</InfoNotice>      // 14px radius, icon + text
 *   <StatusBanner tone="info" title="Awaiting approval" action={<Button variant="outline">View</Button>}>
 *     We'll email you when an admin reviews your documents.
 *   </StatusBanner>
 *   <SectionCard title="Needs attention" count={3} meta="checked 14s ago">…rows…</SectionCard>
 *   <ExplanationBox title="Green Leaf declined your order (Out of stock). ₹218.10 refund initiated.">
 *     Your Spice Route order isn't affected and is still on its way.
 *   </ExplanationBox>
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

type NoticeTone = 'warn' | 'info' | 'ok' | 'bad' | 'neutral' | 'acc';

const toneBg: Record<NoticeTone, string> = {
  warn: 'bg-warn-bg', info: 'bg-info-bg', ok: 'bg-ok-bg', bad: 'bg-bad-bg', neutral: 'bg-fill', acc: 'bg-acc-soft',
};
const toneText: Record<NoticeTone, string> = {
  warn: 'text-warn', info: 'text-info', ok: 'text-ok', bad: 'text-bad', neutral: 'text-fg-3', acc: 'text-acc-fg',
};
const toneDot: Record<NoticeTone, string> = {
  warn: 'bg-warn', info: 'bg-info', ok: 'bg-ok', bad: 'bg-bad', neutral: 'bg-fg-3', acc: 'bg-acc',
};

export function InfoNotice({ children, tone = 'warn', icon = 'info', role, className }: { children: ReactNode; tone?: NoticeTone; icon?: IconName; role?: 'status' | 'alert' | 'note'; className?: string }) {
  return (
    <div role={role} className={cn('flex gap-2.5 rounded-field border border-line px-4 py-3.5 text-[13px] leading-normal text-fg-2', toneBg[tone], className)}>
      <Icon name={icon} size={16} className={cn('mt-0.5', toneText[tone])} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function StatusBanner({ tone = 'info', title, children, action, className }: { tone?: NoticeTone; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-3 rounded-field border border-line px-4 py-3.5', toneBg[tone], className)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', toneDot[tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium text-fg">{title}</p>
        {children ? <div className="text-[13px] text-fg-3">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export interface SectionCardProps {
  title: ReactNode;
  count?: number;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Heading level (default h2). */
  as?: 'h2' | 'h3';
  className?: string;
  bodyClassName?: string;
}

export function SectionCard({ title, count, meta, actions, children, as: H = 'h2', className, bodyClassName }: SectionCardProps) {
  return (
    <section className={cn('overflow-hidden rounded-field border border-line bg-card', className)}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3.5">
        <H className="text-[14.5px] text-fg">{title}</H>
        <div className="flex items-center gap-3">
          {count !== undefined ? <span className="font-mono text-[11px] font-medium text-fg-3">{count}</span> : null}
          {meta ? <span className="text-xs text-fg-3">{meta}</span> : null}
          {actions}
        </div>
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** List row inside a SectionCard: `padding:12px 16px; border-bottom`. */
export function SectionRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0', className)}>{children}</div>;
}

export function ExplanationBox({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-control border border-line bg-bg-2 px-4 py-3.5', className)}>
      <p className="text-[15px] font-medium leading-normal text-fg">{title}</p>
      {children ? <p className="text-[13.5px] text-fg-3">{children}</p> : null}
    </div>
  );
}
