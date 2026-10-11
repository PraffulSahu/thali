/**
 * Role-area layout routes. Each area is a pathless layout route in the single data router
 * (src/routes.tsx); its `routes` are patched in as real CHILD routes the first time the user navigates
 * into the area (`patchRoutesOnNavigation`), so everything the data router supports works inside areas:
 * route `lazy`, `errorElement` / `ErrorBoundary`, loaders, `handle`, nested layouts with <Outlet/>.
 *
 * Area module contract (features/<area>/routes.tsx):
 *   export const routes: RouteObject[];          // required; paths RELATIVE to the area root, index = area home,
 *                                                // keep a '*' NotFound
 *   export const nav?: NavItem[];                // shell navigation (absolute `to` paths)
 *   export const HeaderActions?: ComponentType;  // legacy extra header controls (consumer: location + cart)
 *   export const wide?: boolean;                 // full-bleed main column
 *   export const shell?: ConsumerShellConfig | RoleShellConfig;   // shell slots (location chip, context card…)
 *   export const chrome?: 'auto' | 'none';       // 'none' = the area mounts its own shells as layout routes
 *
 * `/` is NOT a consumer route: it is always the public landing (publicRoutes index, same page as /welcome).
 * The consumer home (Discover) lives at `/discover` (user decision 2026-10-11, ADR-034 note).
 *
 * <AreaLayout> = AppShell (area nav) + path-based guard + Suspense (for React.lazy pages) + <Outlet/>.
 * Guards (by path):
 *   consumer   no area guard: guests browse; wrap private pages in <RequireAuth>
 *   restaurant RESTAURANT_OWNER, except /restaurant/onboarding* which only needs sign-in
 *   partner    DELIVERY_PARTNER, except /partner/onboarding* which only needs sign-in
 *   admin      ADMIN + MFA (amr has 'mfa'), except /admin/login* which is public
 */
import { Suspense, type ComponentType, type ReactNode } from 'react';
import { isRouteErrorResponse, Outlet, useLocation, useRouteError, type RouteObject } from 'react-router';
import { useAuth } from '../../lib/auth';
import { AppShell, type AreaKey } from './AppShell';
import { AREA_HOME } from './ShellParts';
import type { ConsumerShellConfig } from './ConsumerShell';
import type { RoleShellConfig } from './RoleSidebarShell';
import { CrashView, NotFoundPage } from './ErrorBoundary';
import { RequireAuth, RequireRole } from './RequireRole';
import type { NavItem } from './RoleNav';
import { Spinner } from '../ui/Spinner';

export interface AreaModule {
  routes: RouteObject[];
  nav?: NavItem[];
  HeaderActions?: ComponentType;
  wide?: boolean;
  shell?: ConsumerShellConfig | RoleShellConfig;
  chrome?: 'auto' | 'none';
}

/* ------------------------------------------------------------------ area module registry */

const loadedModules = new Map<AreaKey, AreaModule>();

/** Remember a loaded area module so its layout can read nav / HeaderActions / wide synchronously. */
export function registerAreaModule(area: AreaKey, module: AreaModule): void {
  loadedModules.set(area, module);
}

export function getAreaModule(area: AreaKey): AreaModule | undefined {
  return loadedModules.get(area);
}

/* ------------------------------------------------------------------ guards */

export const AREA_PUBLIC_PREFIX: Partial<Record<AreaKey, string>> = {
  restaurant: '/restaurant/onboarding',
  partner: '/partner/onboarding',
  admin: '/admin/login',
};

function startsWithSegment(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function AreaGuard({ area, children }: { area: AreaKey; children: ReactNode }) {
  const { pathname } = useLocation();
  const open = AREA_PUBLIC_PREFIX[area];
  const inOpenPath = open !== undefined && startsWithSegment(pathname, open);
  switch (area) {
    case 'consumer':
      return <>{children}</>;
    case 'restaurant':
      return inOpenPath ? (
        <RequireAuth signInMessage="Sign in with your phone number to register your restaurant.">{children}</RequireAuth>
      ) : (
        <RequireRole
          role="RESTAURANT_OWNER"
          forbiddenTitle="No restaurant on this account yet"
          forbiddenMessage="Register your restaurant to manage menus, orders and payouts here."
          forbiddenAction={{ label: 'Register your restaurant', to: '/restaurant/onboarding' }}
          signInMessage="Sign in with the phone number you used to register your restaurant."
        >
          {children}
        </RequireRole>
      );
    case 'partner':
      return inOpenPath ? (
        <RequireAuth signInMessage="Sign in with your phone number to become a delivery partner.">{children}</RequireAuth>
      ) : (
        <RequireRole
          role="DELIVERY_PARTNER"
          forbiddenTitle="You're not a delivery partner yet"
          forbiddenMessage="Sign up as a delivery partner to receive delivery offers and track earnings."
          forbiddenAction={{ label: 'Become a delivery partner', to: '/partner/onboarding' }}
          signInMessage="Sign in with the phone number you registered as a partner."
        >
          {children}
        </RequireRole>
      );
    case 'admin':
      return inOpenPath ? (
        <>{children}</>
      ) : (
        <RequireRole role="ADMIN" requireMfa signInPath="/admin/login" signInMessage="Admin console access needs your admin email, password and authenticator code.">
          {children}
        </RequireRole>
      );
  }
}

function useNavVisible(area: AreaKey): boolean {
  const auth = useAuth();
  switch (area) {
    case 'consumer':
      return true;
    case 'restaurant':
      return auth.hasRole('RESTAURANT_OWNER');
    case 'partner':
      return auth.hasRole('DELIVERY_PARTNER');
    case 'admin':
      return auth.hasRole('ADMIN') && auth.hasMfa;
  }
}

/* ------------------------------------------------------------------ layout + error routes */

/** Shown while a React.lazy page inside an area suspends (route `lazy` keeps the previous page instead). */
export function PageLoading() {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-24 text-fg-3">
      <Spinner label={null} size={22} />
      <span>Loading…</span>
    </div>
  );
}

function AreaChrome({ area, children, force }: { area: AreaKey; children: ReactNode; force?: boolean }) {
  const module = getAreaModule(area);
  const showNav = useNavVisible(area);
  if (module?.chrome === 'none' && !force) return <>{children}</>;
  return (
    <AppShell variant={area} nav={module?.nav} HeaderActions={module?.HeaderActions} showNav={showNav} wide={module?.wide} shell={module?.shell}>
      {children}
    </AppShell>
  );
}

/** Layout route element for an area: shell + guard + Suspense + child routes. */
export function AreaLayout({ area }: { area: AreaKey }) {
  return (
    <AreaChrome area={area}>
      <AreaGuard area={area}>
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </AreaGuard>
    </AreaChrome>
  );
}

/** Area `ErrorBoundary`: errors thrown by area pages/loaders render inside the area shell. */
export function AreaRouteError({ area }: { area: AreaKey }) {
  const error = useRouteError();
  const home = AREA_HOME[area];
  return (
    <AreaChrome area={area} force>
      {isRouteErrorResponse(error) && error.status === 404 ? <NotFoundPage home={home} /> : <CrashView error={error} home={home} />}
    </AreaChrome>
  );
}
