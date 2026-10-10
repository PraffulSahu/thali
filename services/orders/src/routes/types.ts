/**
 * Route modules: each area (cart, checkouts, internal, … Task 12: orders, owner-orders,
 * admin-orders, support) registers its Express routes AND its OpenAPI docs. `routes/index.ts`
 * lists the modules; `app.ts` and `openapi.ts` iterate that list.
 */
import type { Express } from 'express';
import type { OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';

export interface RouteModule {
  name: string;
  register(app: Express, ctx: OrdersContext): void;
  openapi(openapi: OpenApi): void;
}
