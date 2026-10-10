/**
 * Route tree: ONE react-router v7 data router. Each role area is a pathless layout route
 * (`AreaLayout` = shell + guard) whose children are patched in from `features/<area>/routes.tsx` the first
 * time the user navigates into that area (`patchRoutesOnNavigation`, i.e. lazy route discovery). Area
 * modules stay code-split, and their routes are real data-router children, so route `lazy`,
 * `errorElement`/`ErrorBoundary`, loaders and React.lazy elements all work.
 *
 *   /signin              shared OTP sign-in (?next=)
 *   /restaurant/*        restaurant area (RESTAURANT_OWNER; /restaurant/onboarding needs sign-in only)
 *   /partner/*           delivery partner area (DELIVERY_PARTNER; /partner/onboarding needs sign-in only)
 *   /admin/*             admin area (ADMIN + MFA; /admin/login public)
 *   /*                   consumer area (guests allowed)
 *
 * Usage: `createAppRouter()` in App; tests: `const cfg = createAppRouterConfig();
 * createMemoryRouter(cfg.routes, { initialEntries, patchRoutesOnNavigation: cfg.patchRoutesOnNavigation })`.
 */
import { createBrowserRouter, type PatchRoutesOnNavigationFunction, type RouteObject } from 'react-router';
import type { AreaKey } from './components/layout/AppShell';
import { RouteErrorPage } from './components/layout/ErrorBoundary';
import { SessionLoading } from './components/layout/RequireRole';
import { AreaLayout, AreaRouteError, registerAreaModule, type AreaModule } from './components/layout/RoleArea';
import { RootLayout } from './components/layout/RootLayout';

const AREA_LOADERS: Record<AreaKey, () => Promise<AreaModule>> = {
  consumer: () => import('./features/consumer/routes'),
  restaurant: () => import('./features/restaurant/routes'),
  partner: () => import('./features/partner/routes'),
  admin: () => import('./features/admin/routes'),
};

const AREAS: AreaKey[] = ['restaurant', 'partner', 'admin', 'consumer'];
const areaRouteId = (area: AreaKey) => `area:${area}`;

/** Which area owns a pathname: /restaurant*, /partner*, /admin* by first segment; everything else is consumer. */
export function areaForPath(pathname: string): AreaKey {
  const first = pathname.split('/').filter(Boolean)[0];
  return first === 'restaurant' || first === 'partner' || first === 'admin' ? first : 'consumer';
}

/** Children to patch under an area's layout route. Non-consumer areas are mounted under their base path. */
function areaChildren(area: AreaKey, module: AreaModule): RouteObject[] {
  return area === 'consumer' ? module.routes : [{ path: area, children: module.routes }];
}

export const appRoutes: RouteObject[] = [
  {
    id: 'root',
    element: <RootLayout />,
    errorElement: <RouteErrorPage />,
    // Shown while the first route (and area module) loads.
    HydrateFallback: SessionLoading,
    children: [
      { path: 'signin', lazy: () => import('./components/auth/SignInPage').then((m) => ({ Component: m.default })) },
      // Pathless + no children = matches nothing until its routes are patched in.
      ...AREAS.map(
        (area): RouteObject => ({
          id: areaRouteId(area),
          element: <AreaLayout area={area} />,
          errorElement: <AreaRouteError area={area} />,
          children: [],
        }),
      ),
    ],
  },
];

const moduleCache = new Map<AreaKey, Promise<AreaModule>>();
function loadArea(area: AreaKey): Promise<AreaModule> {
  let p = moduleCache.get(area);
  if (!p) {
    p = AREA_LOADERS[area]().then((m) => {
      registerAreaModule(area, m);
      return m;
    });
    p.catch(() => moduleCache.delete(area)); // allow a retry after a failed chunk load
    moduleCache.set(area, p);
  }
  return p;
}

/** Routes + a per-router lazy-discovery function (patched state is per router instance). */
export function createAppRouterConfig(): { routes: RouteObject[]; patchRoutesOnNavigation: PatchRoutesOnNavigationFunction } {
  const patched = new Set<AreaKey>();
  const patchRoutesOnNavigation: PatchRoutesOnNavigationFunction = async ({ path, patch, signal }) => {
    const area = areaForPath(path);
    if (patched.has(area)) return;
    const module = await loadArea(area);
    if (signal.aborted || patched.has(area)) return;
    patch(areaRouteId(area), areaChildren(area, module));
    patched.add(area);
  };
  return { routes: appRoutes, patchRoutesOnNavigation };
}

export function createAppRouter() {
  const { routes, patchRoutesOnNavigation } = createAppRouterConfig();
  return createBrowserRouter(routes, { patchRoutesOnNavigation });
}
