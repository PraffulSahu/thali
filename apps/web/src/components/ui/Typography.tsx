/**
 * Small typographic and label primitives (design-spec §2.2, §3.27, §3.35).
 *
 *   <h1>What are you <AccentWord>craving?</AccentWord></h1>    // Bricolage 800 in --acc, 1.1em
 *   <Eyebrow>How it works</Eyebrow>                            // marketing eyebrow (800 12.5px uppercase)
 *   <Lbl>Orders today</Lbl>                                    // mono 11.5px uppercase label (.lbl)
 *   <RoleTag>KITCHEN</RoleTag>                                 // sidebar role tag
 *   <Kbd>/</Kbd>  <Kbd>⌘K</Kbd>
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function AccentWord({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('accent-word', className)}>{children}</span>;
}

export function Eyebrow({ children, onColor, className }: { children: ReactNode; onColor?: 'chili' | 'ink'; className?: string }) {
  return (
    <p className={cn('eyebrow', onColor === 'chili' && 'text-[#ffd7c7]!', onColor === 'ink' && 'text-[#ffc145]!', className)}>{children}</p>
  );
}

export function Lbl({ children, as: As = 'span', className }: { children: ReactNode; as?: 'span' | 'p' | 'h2' | 'h3' | 'dt'; className?: string }) {
  return <As className={cn('lbl', className)}>{children}</As>;
}

export function RoleTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-tag border border-line px-[5px] py-0.5 font-mono text-[10.5px] leading-none tracking-[.04em] text-fg-3', className)}>
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex items-center rounded-tag border border-line px-1.5 py-0.5 font-mono text-[11px] font-normal leading-none text-fg-3', className)}>
      {children}
    </kbd>
  );
}
