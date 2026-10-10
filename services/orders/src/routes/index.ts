/**
 * Route modules registered by `app.ts` and documented by `openapi.ts`, in this order.
 * Task 12: append `ordersModule`, `ownerOrdersModule`, `adminOrdersModule`, `supportModule`,
 * `adminSupportModule`, `internalOrdersModule` here — nothing else needs to change.
 */
import type { RouteModule } from './types.js';
import { cartModule } from './cart.js';
import { checkoutsModule } from './checkouts.js';
import { internalModule } from './internal.js';
import { ordersModule } from './orders.js';
import { ownerOrdersModule } from './owner-orders.js';
import { adminOrdersModule } from './admin-orders.js';
import { supportModule } from './support.js';
import { adminSupportModule } from './admin-support.js';
import { internalOrdersModule } from './internal-orders.js';

export const routeModules: RouteModule[] = [
  cartModule,
  checkoutsModule,
  internalModule,
  ordersModule,
  ownerOrdersModule,
  adminOrdersModule,
  supportModule,
  adminSupportModule,
  internalOrdersModule,
];

export type { RouteModule };
