/**
 * Route tree (react-router v7, data router). Each role area is code-split: its `features/<area>/routes.tsx`
 * module (and everything it imports) loads on first visit, then RoleArea renders the area's own relative
 * routes inside the area shell + guard.
 *
 *   /signin              shared OTP sign-in (?next=)
 *   /restaurant/*        restaurant area (RESTAURANT_OWNER; /restaurant/onboarding needs sign-in only)
 *   /partner/*           delivery partner area (DELIVERY_PARTNER; /partner/onboarding needs sign-in only)
 *   /admin/*             admin area (ADMIN + MFA; /admin/login public)
 *   /*                   consumer area (guests allowed)
 */
import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { RouteErrorPage } from './components/layout/ErrorBoundary';
import type { AreaKey } from './components/layout/AppShell';
import { SessionLoading } from './components/layout/RequireRole';
import { RoleArea, type AreaModule } from './components/layout/RoleArea';
import { RootLayout } from './components/layout/RootLayout';

function area(key: AreaKey, path: string, load: () => Promise<AreaModule>): RouteObject {
  return {
    path,
    lazy: async () => {
      const module = await load();
      const Component: ComponentType = () => <RoleArea area={key} module={module} />;
      return { Component };
    },
  };
}

export const appRoutes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteErrorPage />,
    // Shown while the first lazy area chunk loads.
    HydrateFallback: SessionLoading,
    children: [
      { path: 'signin', lazy: () => import('./components/auth/SignInPage').then((m) => ({ Component: m.default })) },
      area('restaurant', 'restaurant/*', () => import('./features/restaurant/routes')),
      area('partner', 'partner/*', () => import('./features/partner/routes')),
      area('admin', 'admin/*', () => import('./features/admin/routes')),
      area('consumer', '*', () => import('./features/consumer/routes')),
    ],
  },
];
