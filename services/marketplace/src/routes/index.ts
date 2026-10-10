/**
 * Route module registry — the single list `app.ts` and `openapi.ts` iterate. Order matters only
 * within a module (e.g. `/restaurants/verify-email` before `/restaurants/:idOrSlug`).
 * Task 9: append its modules (coupons, memberships, ratings, owner-dashboard, admin-promotions,
 * internal-commerce) here.
 */
import type { RouteModule } from '../context.js';
import { adminCatalogRoutes } from './admin-catalog.js';
import { adminRestaurantRoutes } from './admin-restaurants.js';
import { discoveryRoutes } from './discovery.js';
import { internalRoutes } from './internal.js';
import { ownerMenuRoutes } from './owner-menu.js';
import { ownerRestaurantRoutes } from './owner-restaurants.js';
import { restaurantsPublicRoutes } from './restaurants-public.js';

export const routeModules: RouteModule[] = [
  discoveryRoutes,
  restaurantsPublicRoutes,
  ownerRestaurantRoutes,
  ownerMenuRoutes,
  adminRestaurantRoutes,
  adminCatalogRoutes,
  internalRoutes,
];
