/**
 * Failure states. All use role="alert" (ErrorState) or a heading, plus a recovery path.
 *
 *   <ErrorState error={query.error} onRetry={() => query.refetch()} />
 *   <ForbiddenState />                                    // 403 / missing role
 *   <SessionExpiredState />                               // 401 inside a page (links to sign-in, keeps route)
 *   <InlineError error={mutation.error} />                // compact, under a form / next to a button
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { cn } from '../../lib/cn';
import { errorMessage, isApiError } from '../../lib/errors';
import { Button, ButtonLink } from './Button';
import { Icon } from './Icon';

/** Same footprint as EmptyState (design-spec §3.32): solid --line card; compact = no frame. */
const frame = (compact?: boolean) =>
  cn('flex flex-col items-center text-center', compact ? 'gap-2 px-4 py-8' : 'gap-3 rounded-card border border-line bg-card px-6 py-10');
const titleClass = 'font-sans text-[17px] font-semibold tracking-normal text-fg';

export interface ErrorStateProps {
  error?: unknown;
  title?: ReactNode;
  /** Overrides the message derived from `error`. */
  message?: ReactNode;
  onRetry?: () => unknown;
  retrying?: boolean;
  compact?: boolean;
  className?: string;
}

export function ErrorState({ error, title = "Couldn't load this", message, onRetry, retrying, compact, className }: ErrorStateProps) {
  const requestId = isApiError(error) ? error.requestId : undefined;
  return (
    <div role="alert" className={cn(frame(compact), className)}>
      <span className="grid size-9 place-items-center rounded-item bg-bad-bg text-bad">
        <Icon name="alert" size={18} />
      </span>
      <h2 className={titleClass}>{title}</h2>
      <p className="max-w-prose text-sm text-fg-3">{message ?? errorMessage(error)}</p>
      {requestId ? <p className="font-mono text-xs text-fg-3">Reference: {requestId}</p> : null}
      {onRetry ? (
        <Button variant="outline" icon="refresh" onClick={() => void onRetry()} loading={retrying} className="mt-1">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export interface ForbiddenStateProps {
  title?: ReactNode;
  message?: ReactNode;
  /** Primary way forward, e.g. { label: 'Register your restaurant', to: '/restaurant/onboarding' }. */
  action?: { label: string; to: string };
  homeTo?: string;
  className?: string;
}

export function ForbiddenState({
  title = "You don't have access to this page",
  message = 'Your account doesn’t have the role needed here. If you think this is a mistake, contact support.',
  action,
  homeTo = '/',
  className,
}: ForbiddenStateProps) {
  return (
    <div className={cn(frame(false), className)}>
      <span className="grid size-9 place-items-center rounded-item bg-warn-bg text-warn">
        <Icon name="shield" size={18} />
      </span>
      <h2 className={titleClass}>{title}</h2>
      <p className="max-w-prose text-sm text-fg-3">{message}</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {action ? <ButtonLink to={action.to}>{action.label}</ButtonLink> : null}
        <ButtonLink to={homeTo} variant={action ? 'ghost' : 'primary'}>
          Go to home
        </ButtonLink>
      </div>
    </div>
  );
}

/** Builds `/signin?next=<current path+search>` (or another sign-in path). */
export function useSignInHref(signInPath = '/signin'): string {
  const loc = useLocation();
  return `${signInPath}?next=${encodeURIComponent(loc.pathname + loc.search)}`;
}

export function SessionExpiredState({ signInPath = '/signin', className }: { signInPath?: string; className?: string }) {
  const href = useSignInHref(signInPath);
  return (
    <div className={cn(frame(false), className)}>
      <span className="grid size-9 place-items-center rounded-item bg-info-bg text-info">
        <Icon name="clock" size={18} />
      </span>
      <h2 className={titleClass}>Session expired</h2>
      <p className="max-w-prose text-sm text-fg-3">Sign in again to continue where you left off.</p>
      <ButtonLink to={href} className="mt-1">
        Sign in again
      </ButtonLink>
    </div>
  );
}

/** Compact error line for forms and actions. Renders nothing when `error` is falsy. */
export function InlineError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn('flex items-start gap-1.5 text-[13px] font-medium text-bad', className)}>
      <Icon name="alert" size={14} className="mt-0.5" />
      <span>{errorMessage(error)}</span>
    </p>
  );
}
