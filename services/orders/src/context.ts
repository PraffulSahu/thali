/**
 * The orders service context: everything route modules, event handlers and jobs need. Stateless
 * (models are cached per connection), so creating it more than once from the same deps is fine.
 */
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { AuthVerifier, Redis } from '@thali/service-kit';
import type { OrdersConfig } from './config.js';
import type { MarketplaceClient } from './clients/marketplace.js';
import type { PaymentsClient } from './clients/payments.js';
import type { IdentityClient } from './clients/identity.js';
import { getModels, type OrdersModels } from './models/index.js';

export interface OrdersClients {
  marketplace: MarketplaceClient;
  payments: PaymentsClient;
  identity: IdentityClient;
}

export interface AppDeps {
  config: OrdersConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  /** Access-token verifier; default built from `JWKS_URL` + redis. Tests inject a test JWKS. */
  auth?: AuthVerifier;
  clients: OrdersClients;
}

export interface OrdersContext extends AppDeps {
  models: OrdersModels;
}

export function createOrdersContext(deps: AppDeps): OrdersContext {
  return { ...deps, models: getModels(deps.conn) };
}
