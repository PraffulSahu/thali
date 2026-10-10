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
    <div
      role="alert"
      className={cn('flex flex-col items-center text-center', compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14', className)}
    >
      <span className={cn('grid place-items-center rounded-full bg-danger-50 text-danger-700', compact ? 'size-11' : 'size-14')}>
        <Icon name="alert" size={compact ? 22 : 26} />
      </span>
      <h2 className={cn('font-semibold text-slate-900', compact ? 'text-base' : 'text-lg')}>{title}</h2>
      <p className="max-w-prose text-[0.9375rem] text-slate-600">{message ?? errorMessage(error)}</p>
      {requestId ? <p className="font-mono text-xs text-slate-500">Reference: {requestId}</p> : null}
      {onRetry ? (
        <Button variant="secondary" icon="refresh" onClick={() => void onRetry()} loading={retrying} className="mt-2">
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
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      <span className="grid size-14 place-items-center rounded-full bg-warn-50 text-warn-700">
        <Icon name="shield" size={26} />
      </span>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="max-w-prose text-[0.9375rem] text-slate-600">{message}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {action ? <ButtonLink to={action.to}>{action.label}</ButtonLink> : null}
        <ButtonLink to={homeTo} variant={action ? 'secondary' : 'primary'}>
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
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      <span className="grid size-14 place-items-center rounded-full bg-info-50 text-info-700">
        <Icon name="clock" size={26} />
      </span>
      <h2 className="text-lg font-semibold text-slate-900">Session expired</h2>
      <p className="max-w-prose text-[0.9375rem] text-slate-600">Sign in again to continue where you left off.</p>
      <ButtonLink to={href} className="mt-2">
        Sign in again
      </ButtonLink>
    </div>
  );
}

/** Compact error line for forms and actions. Renders nothing when `error` is falsy. */
export function InlineError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn('flex items-start gap-1.5 text-sm font-medium text-danger-700', className)}>
      <Icon name="alert" size={16} className="mt-0.5" />
      <span>{errorMessage(error)}</span>
    </p>
  );
}
