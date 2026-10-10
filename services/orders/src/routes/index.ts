/**
 * Route modules registered by `app.ts` and documented by `openapi.ts`, in this order.
 * Task 12: append `ordersModule`, `ownerOrdersModule`, `adminOrdersModule`, `supportModule`,
 * `adminSupportModule`, `internalOrdersModule` here — nothing else needs to change.
 */
import type { RouteModule } from './types.js';
import { cartModule } from './cart.js';
import { checkoutsModule } from './checkouts.js';
import { internalModule } from './internal.js';

export const routeModules: RouteModule[] = [cartModule, checkoutsModule, internalModule];

export type { RouteModule };
