/**
 * Orders service configuration (LLD §12). Base fields come from service-kit `loadConfig`.
 */
import { z } from 'zod';
import { loadConfig, type BaseConfig } from '@thali/service-kit';

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

export const ordersConfigShape = {
  PORT: int(4003, 0),
  /** Restaurant acceptance window after placement (LLD §4.1). */
  ACCEPT_WINDOW_SEC: int(300, 1),
  /** Checkout/payment window; also the marketplace reservation TTL (LLD §8). */
  CHECKOUT_TTL_SEC: int(900, 60),
  FOOD_TAX_BPS: int(500),
  FEE_TAX_BPS: int(1800),
  PLATFORM_FEE_PAISE: int(500),
  /** Guest carts expire after this many days (LLD §3.3). */
  GUEST_CART_TTL_DAYS: int(7, 1),
  /** Sweeper interval for expired AWAITING_PAYMENT checkouts (LLD §8 sweeper a). */
  CHECKOUT_EXPIRY_INTERVAL_MS: int(30_000, 100),
  /** AUTHORIZED payments get this grace past expiresAt for auto-capture before the checkout is expired. */
  AUTHORIZED_GRACE_SEC: int(600, 0),
  /** Sweeper interval for PLACED children past `acceptBy` (LLD §8 sweeper b → REJECTED RESTAURANT_TIMEOUT). */
  ACCEPT_TIMEOUT_INTERVAL_MS: int(15_000, 100),
  /** Checkout create rate limit per user per minute (LLD §5.4). */
  CHECKOUT_RATE_LIMIT_PER_MIN: int(10, 1),
  IDENTITY_URL: z.url().default('http://localhost:4001'),
  MARKETPLACE_URL: z.url().default('http://localhost:4002'),
  PAYMENTS_URL: z.url().default('http://localhost:4004'),
  /** Timeout for calls to other services. */
  INTERNAL_HTTP_TIMEOUT_MS: int(5000, 100),
};

type Shape = typeof ordersConfigShape;
export type OrdersOwnConfig = { [K in keyof Shape]: z.output<Shape[K]> };
export type OrdersConfig = BaseConfig & OrdersOwnConfig;

/** Defaults of the orders-specific fields (tests merge these into `createTestConfig`). */
export const ORDERS_CONFIG_DEFAULTS: OrdersOwnConfig = z.object(ordersConfigShape).parse({});

export function loadOrdersConfig(env: NodeJS.ProcessEnv = process.env): OrdersConfig {
  return loadConfig(ordersConfigShape, { SERVICE_NAME: 'orders', ...env }) as OrdersConfig;
}
