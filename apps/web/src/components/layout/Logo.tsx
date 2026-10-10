/**
 * Thali logo: chili mark + lower-case "thali" wordmark in Bricolage 800 (design-spec §3.35).
 *
 *   <Logo />                                   // app header: 26px mark + 23px wordmark, links to "/"
 *   <Logo size="public" />                     // public header: 34px ringed mark + 25px wordmark
 *   <Logo size="sidebar" to="/admin" subtitle="Admin" />   // 24px + 22px; accessible name "Thali Admin, home"
 *   <Logo markOnly size="sidebar" />           // icon rail / mobile top bar
 */
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { LogoMark as Mark } from '../illustrations';

export function LogoMark({ size = 28, ring, className }: { size?: number; ring?: boolean; className?: string }) {
  return <Mark size={size} ring={ring} className={cn('shrink-0', className)} />;
}

const SIZES = {
  public: { mark: 34, word: 'text-[25px]', ring: true },
  app: { mark: 26, word: 'text-[23px]', ring: false },
  sidebar: { mark: 24, word: 'text-[22px]', ring: false },
  footer: { mark: 28, word: 'text-[22px]', ring: false },
};

export interface LogoProps {
  to?: string;
  /** Read by screen readers only ("Thali Admin, home"); the role tag shows it visually. */
  subtitle?: string;
  size?: keyof typeof SIZES;
  markOnly?: boolean;
  className?: string;
}

export function Logo({ to = '/', subtitle, size = 'app', markOnly, className }: LogoProps) {
  const s = SIZES[size];
  return (
    <Link
      to={to}
      className={cn('inline-flex min-h-10 shrink-0 items-center gap-2 rounded-control pr-1 text-fg', className)}
      aria-label={subtitle ? `Thali ${subtitle}, home` : 'Thali, home'}
    >
      <LogoMark size={s.mark} ring={s.ring} />
      {markOnly ? null : <span className={cn('font-display font-extrabold leading-none tracking-[-0.03em]', s.word)}>thali</span>}
    </Link>
  );
}
