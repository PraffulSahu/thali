/**
 * Orders models bound to a connection. Task 12 adds `supportTicketModel` here (and to
 * `initOrdersDb` via `extraModelInits`).
 */
import type { Connection, Model } from 'mongoose';
import { initEventCollections, idempotencyModel } from '@thali/service-kit';
import { cartModel, type Cart } from './cart.js';
import { checkoutGroupModel, type CheckoutGroup } from './checkout-group.js';
import { childOrderModel, type ChildOrder } from './child-order.js';
import { orderEventModel, type OrderEvent } from './order-event.js';
import { restaurantProjectionModel, type RestaurantProjection } from './restaurant-projection.js';

export interface OrdersModels {
  Cart: Model<Cart>;
  CheckoutGroup: Model<CheckoutGroup>;
  ChildOrder: Model<ChildOrder>;
  OrderEvent: Model<OrderEvent>;
  RestaurantProjection: Model<RestaurantProjection>;
}

export function getModels(conn: Connection): OrdersModels {
  return {
    Cart: cartModel(conn),
    CheckoutGroup: checkoutGroupModel(conn),
    ChildOrder: childOrderModel(conn),
    OrderEvent: orderEventModel(conn),
    RestaurantProjection: restaurantProjectionModel(conn),
  };
}

/** Additional model factories whose collections/indexes must exist before serving (Task 12 appends). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const extraModelInits: ((conn: Connection) => Model<any>)[] = [];

/**
 * Create collections + indexes (incl. the unique partial checkout index) and the service-kit
 * outbox/inbox/dead-letter/idempotency collections. Call at boot before serving, and in tests.
 */
export async function initOrdersDb(conn: Connection): Promise<void> {
  await initEventCollections(conn);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models: Model<any>[] = [...Object.values(getModels(conn)), idempotencyModel(conn), ...extraModelInits.map((f) => f(conn))];
  await Promise.all(models.map((m) => m.init()));
}

export * from './cart.js';
export * from './checkout-group.js';
export * from './child-order.js';
export * from './order-event.js';
export * from './restaurant-projection.js';
export * from './common.js';
