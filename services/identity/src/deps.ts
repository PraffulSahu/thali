import type { Logger } from 'pino';
import type { Connection } from 'mongoose';
import type { Redis, StorageProvider } from '@thali/service-kit';
import type { IdentityConfig } from './config.js';
import type { KeyStore } from './domain/tokens.js';
import type { NotificationsClient } from './clients/notifications.js';
import type { OrdersClient } from './clients/orders.js';
import type { Models } from './models/index.js';
import type { ImageResolver } from './domain/views.js';

/** Dependencies injected into `buildApp` (tests pass fakes for the clients). */
export interface AppDeps {
  config: IdentityConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  keys: KeyStore;
  notifications: NotificationsClient;
  orders: OrdersClient;
  /** Public-bucket storage for avatar uploads (IDN-3). */
  storage: StorageProvider;
  /** Optional observer for work that continues after the response (e.g. forgot-password email); tests await it. */
  onBackgroundTask?: (task: Promise<unknown>) => void;
}

/** AppDeps + registered models (what route/domain code receives). */
export interface Ctx extends AppDeps {
  m: Models;
  /** `resolveImageUrl(storage, ref, EXTERNAL_IMAGE_HOSTS)`. */
  imageUrl: ImageResolver;
}
