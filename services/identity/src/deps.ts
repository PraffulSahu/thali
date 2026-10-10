import type { Logger } from 'pino';
import type { Connection } from 'mongoose';
import type { Redis } from '@thali/service-kit';
import type { IdentityConfig } from './config.js';
import type { KeyStore } from './domain/tokens.js';
import type { NotificationsClient } from './clients/notifications.js';
import type { OrdersClient } from './clients/orders.js';
import type { Models } from './models/index.js';

/** Dependencies injected into `buildApp` (tests pass fakes for the clients). */
export interface AppDeps {
  config: IdentityConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  keys: KeyStore;
  notifications: NotificationsClient;
  orders: OrdersClient;
}

/** AppDeps + registered models (what route/domain code receives). */
export interface Ctx extends AppDeps {
  m: Models;
}
