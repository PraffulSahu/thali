import { cn } from '../../lib/cn';

export interface SpinnerProps {
  size?: number;
  /** Screen-reader text. Pass `null` when the parent already announces loading (e.g. a busy button). */
  label?: string | null;
  className?: string;
}

/** Inline loading indicator. For content areas prefer <Skeleton> (layout-stable). */
export function Spinner({ size = 18, label = 'Loading', className }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className={cn('animate-spin-btn shrink-0', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
  if (label === null) return svg;
  return (
    <span role="status" className="inline-flex items-center">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
