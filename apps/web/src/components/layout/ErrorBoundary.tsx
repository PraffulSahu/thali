/**
 * Render-error safety nets.
 *  - <AreaErrorBoundary>: a plain React error boundary that resets when the path changes (for widgets
 *    outside the router's error handling; area routes already get <AreaRouteError> from RoleArea).
 *  - <CrashView>: the shared "Something went wrong / new version available" view.
 *  - <RouteErrorPage> is the router `errorElement` (e.g. a lazy chunk failed to load after a deploy).
 *  - <NotFoundPage> for `*` routes inside areas.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useLocation, useRouteError } from 'react-router';
import { Button, ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';

function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|error loading dynamically/i.test(msg);
}

export function CrashView({ error, home = '/' }: { error: unknown; home?: string }) {
  const chunk = isChunkError(error);
  return (
    <div role="alert" className="mx-auto my-10 flex max-w-xl flex-col items-center gap-3 rounded-card border border-line bg-card px-6 py-10 text-center">
      <span className="grid size-9 place-items-center rounded-item bg-bad-bg text-bad">
        <Icon name="alert" size={18} />
      </span>
      <h1 className="text-2xl text-fg">{chunk ? 'A new version is available' : 'Something went wrong'}</h1>
      <p className="max-w-prose text-sm text-fg-3">
        {chunk
          ? 'Thali was updated while this tab was open. Reload to get the latest version.'
          : 'This page hit an unexpected error. Reloading usually fixes it; your cart and orders are safe.'}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button icon="refresh" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <ButtonLink to={home} variant="ghost">
          Go to home
        </ButtonLink>
      </div>
    </div>
  );
}

interface BoundaryState {
  error: unknown;
}

class Boundary extends Component<{ children: ReactNode; home?: string }, BoundaryState> {
  override state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack);
  }
  override render() {
    return this.state.error ? <CrashView error={this.state.error} home={this.props.home} /> : this.props.children;
  }
}

export function AreaErrorBoundary({ children, home }: { children: ReactNode; home?: string }) {
  const { pathname } = useLocation();
  return (
    <Boundary key={pathname} home={home}>
      {children}
    </Boundary>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <div className="mx-auto max-w-content px-4">
      <CrashView error={error} />
    </div>
  );
}

export function NotFoundPage({ home = '/', homeLabel = 'Go to home' }: { home?: string; homeLabel?: string }) {
  return (
    <EmptyState
      as="h2"
      icon="map"
      title="We couldn't find that page"
      description="The link may be old or mistyped."
      action={<ButtonLink to={home}>{homeLabel}</ButtonLink>}
    />
  );
}
