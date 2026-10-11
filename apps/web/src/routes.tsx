/**
 * Route tree: ONE react-router v7 data router. Each role area is a pathless layout route
 * (`AreaLayout` = shell + guard) whose children are patched in from `features/<area>/routes.tsx` the first
 * time the user navigates into that area (`patchRoutesOnNavigation`, i.e. lazy route discovery). Area
 * modules stay code-split, and their routes are real data-router children, so route `lazy`,
 * `errorElement`/`ErrorBoundary`, loaders and React.lazy elements all work.
 *
 *   /signin              unified sign-in (?role=customer|restaurant|partner|admin&next=)
 *   /admin/login         → redirects to /signin?role=admin (keeps next)
 *   /admin/forgot, /admin/reset-password?token=   admin password reset (IDN-1), public
 *   /, /welcome          public landing (PublicShell + LandingPage), always — `/welcome` is an alias
 *   /terms, /privacy, /refunds, /help, /partner-with-us, /ride-with-thali   public site (PublicShell)
 *   /discover            consumer home (Discover); the landing's address pick / "Find food" / cuisines go here
 *   /restaurant/*        restaurant area (RESTAURANT_OWNER; /restaurant/onboarding needs sign-in only)
 *   /partner/*           delivery partner area (DELIVERY_PARTNER; /partner/onboarding needs sign-in only)
 *   /admin/*             admin area (ADMIN + MFA; /admin/login public)
 *   /*                   consumer area (guests allowed): /discover, /search, /restaurants/:slug, /cart, /orders…
 *
 * Usage: `createAppRouter()` in App; tests: `const cfg = createAppRouterConfig();
 * createMemoryRouter(cfg.routes, { initialEntries, patchRoutesOnNavigation: cfg.patchRoutesOnNavigation })`.
 */
import { createBrowserRouter, Navigate, useLocation, type PatchRoutesOnNavigationFunction, type RouteObject } from 'react-router';
import { PublicShell } from './components/layout/PublicShell';
import { publicRoutes } from './features/public/routes';
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

/** Legacy `/admin/login?next=` → the unified sign-in with the Admin tab. */
export function AdminLoginRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const next = params.get('next');
  return <Navigate to={`/signin?role=admin${next ? `&next=${encodeURIComponent(next)}` : ''}`} replace />;
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
      { path: 'admin/login', element: <AdminLoginRedirect /> },
      { path: 'admin/login/*', element: <AdminLoginRedirect /> },
      { path: 'admin/forgot', lazy: () => import('./components/auth/AdminPasswordPages').then((m) => ({ Component: m.AdminForgotPage })) },
      { path: 'admin/reset-password', lazy: () => import('./components/auth/AdminPasswordPages').then((m) => ({ Component: m.AdminResetPasswordPage })) },
      { id: 'public', element: <PublicShell />, children: publicRoutes },
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
