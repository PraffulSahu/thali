/**
 * Dependencies + per-app context shared by every route module, domain function and event handler.
 *
 * Extending (Task 9): add new clients (orders, payments) as fields on `MarketplaceDeps`, new models
 * in `models/index.ts`, new route modules in `routes/index.ts`, new event handler modules in
 * `events/handlers.ts`. Nothing else needs to change.
 */
import type { Router } from 'express';
import type { Logger } from 'pino';
import type { Connection } from 'mongoose';
import type { AuthVerifier, GeoProvider, OpenApi, Redis, StorageProvider } from '@thali/service-kit';
import type { IdentityClient } from './clients/identity.js';
import type { OrdersClient } from './clients/orders.js';
import type { PaymentsClient } from './clients/payments.js';
import type { MarketplaceConfig } from './config.js';
import type { Models } from './models/index.js';

export interface MarketplaceDeps {
  config: MarketplaceConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  /** Test JWKS injection; production builds it from JWKS_URL + redis. */
  auth?: AuthVerifier;
  geo: GeoProvider;
  storage: StorageProvider;
  identity: IdentityClient;
  /** Task 9: checkout status (sweeper), child order (ratings), stats (dashboard). */
  orders: OrdersClient;
  /** Task 9: membership payment intents. */
  payments: PaymentsClient;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface AppContext extends Omit<MarketplaceDeps, 'now'> {
  models: Models;
  now: () => Date;
}

/**
 * One area of the HTTP API. `register` mounts absolute paths (`/api/v1/...`, `/internal/...`) on the
 * shared router; `openapi` registers the same routes in the service document.
 */
export interface RouteModule {
  name: string;
  register(router: Router, ctx: AppContext): void;
  openapi(api: OpenApi): void;
}
