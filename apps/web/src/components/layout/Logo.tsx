/** Thali mark (a plate with katoris) + wordmark. */
import { Link } from 'react-router';
import { cn } from '../../lib/cn';

export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="16" cy="16" r="15" fill="var(--color-brand-500)" />
      <circle cx="16" cy="16" r="11.5" fill="none" stroke="#fff7ed" strokeWidth="1.5" />
      <circle cx="11.5" cy="13" r="3" fill="#fff7ed" />
      <circle cx="20.5" cy="13" r="3" fill="#ffd2b0" />
      <circle cx="16" cy="20.5" r="3.2" fill="#fff7ed" />
    </svg>
  );
}

export function Logo({ to = '/', subtitle, className }: { to?: string; subtitle?: string; className?: string }) {
  return (
    <Link to={to} className={cn('inline-flex min-h-touch items-center gap-2 rounded-control pr-1', className)} aria-label={subtitle ? `Thali ${subtitle}, home` : 'Thali, home'}>
      <LogoMark />
      <span className="flex items-baseline gap-1.5">
        <span className="text-xl font-extrabold tracking-tight text-slate-900">Thali</span>
        {subtitle ? <span className="hidden text-sm font-medium text-slate-500 sm:inline">{subtitle}</span> : null}
      </span>
    </Link>
  );
}
