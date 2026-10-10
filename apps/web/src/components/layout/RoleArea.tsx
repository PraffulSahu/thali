/**
 * Mounts a lazily-loaded role area: AppShell (with the area's nav) + the area guard + an error boundary +
 * the area's own `routes` (rendered with useRoutes, paths RELATIVE to the area root).
 *
 * Area module contract (features/<area>/routes.tsx):
 *   export const routes: RouteObject[];          // required; index route = area home, add a '*' NotFound
 *   export const nav?: NavItem[];                // shell navigation (absolute `to` paths)
 *   export const HeaderActions?: ComponentType;  // extra header controls (consumer: location + cart)
 *   export const wide?: boolean;                 // full-bleed main column
 *
 * Guards (by path):
 *   consumer   no area guard: guests browse; wrap private pages in <RequireAuth>
 *   restaurant RESTAURANT_OWNER, except /restaurant/onboarding* which only needs sign-in
 *   partner    DELIVERY_PARTNER, except /partner/onboarding* which only needs sign-in
 *   admin      ADMIN + MFA (amr has 'mfa'), except /admin/login* which is public
 */
import type { ComponentType, ReactNode } from 'react';
import { useLocation, useRoutes, type RouteObject } from 'react-router';
import { useAuth } from '../../lib/auth';
import { AppShell, type AreaKey } from './AppShell';
import { AreaErrorBoundary } from './ErrorBoundary';
import { RequireAuth, RequireRole } from './RequireRole';
import type { NavItem } from './RoleNav';

export interface AreaModule {
  routes: RouteObject[];
  nav?: NavItem[];
  HeaderActions?: ComponentType;
  wide?: boolean;
}

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

export function RoleArea({ area, module }: { area: AreaKey; module: AreaModule }) {
  const element = useRoutes(module.routes);
  const showNav = useNavVisible(area);
  return (
    <AppShell variant={area} nav={module.nav} HeaderActions={module.HeaderActions} showNav={showNav} wide={module.wide}>
      <AreaGuard area={area}>
        <AreaErrorBoundary home={area === 'consumer' ? '/' : `/${area}`}>{element}</AreaErrorBoundary>
      </AreaGuard>
    </AppShell>
  );
}
