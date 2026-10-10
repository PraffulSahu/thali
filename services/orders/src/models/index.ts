/**
 * Orders models bound to a connection. Task 12 adds `supportTicketModel` here (and to
 * `initOrdersDb` via `extraModelInits`).
 */
import type { Connection, Model } from 'mongoose';
import { initEventCollections, idempotencyModel } from '@thali/service-kit';
import { cartModel, type Cart } from './cart.js';
import { ACTIVE_CHECKOUT_INDEX, checkoutGroupModel, LEGACY_ACTIVE_CHECKOUT_INDEX, type CheckoutGroup } from './checkout-group.js';
import { childOrderModel, type ChildOrder } from './child-order.js';
import { orderEventModel, type OrderEvent } from './order-event.js';
import { restaurantProjectionModel, type RestaurantProjection } from './restaurant-projection.js';
import { supportTicketModel, type SupportTicket } from './support-ticket.js';

export interface OrdersModels {
  Cart: Model<Cart>;
  CheckoutGroup: Model<CheckoutGroup>;
  ChildOrder: Model<ChildOrder>;
  OrderEvent: Model<OrderEvent>;
  RestaurantProjection: Model<RestaurantProjection>;
  SupportTicket: Model<SupportTicket>;
}

export function getModels(conn: Connection): OrdersModels {
  return {
    Cart: cartModel(conn),
    CheckoutGroup: checkoutGroupModel(conn),
    ChildOrder: childOrderModel(conn),
    OrderEvent: orderEventModel(conn),
    RestaurantProjection: restaurantProjectionModel(conn),
    SupportTicket: supportTicketModel(conn),
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
  await migrateCheckoutIndexes(conn);
}

/**
 * ORD-3 index migration, tolerant of every starting state: the new unique partial index
 * `{userId, cartVersion, restaurantSetKey}` (AWAITING_PAYMENT) is created by `init()` above (from
 * the schema) BEFORE the pre-redesign `{userId, cartVersion}` one is dropped, so there is never a
 * moment without a duplicate-submit backstop. Missing index / collection → no-op. Idempotent.
 */
export async function migrateCheckoutIndexes(conn: Connection): Promise<void> {
  const coll = checkoutGroupModel(conn).collection;
  let names: string[];
  try {
    names = (await coll.indexes()).map((i) => String(i.name));
  } catch (e) {
    if ((e as { code?: number }).code === 26) return; // NamespaceNotFound: nothing to migrate
    throw e;
  }
  if (!names.includes(LEGACY_ACTIVE_CHECKOUT_INDEX)) return;
  // never leave the collection without a duplicate-submit backstop
  if (!names.includes(ACTIVE_CHECKOUT_INDEX)) {
    throw new Error(`orders: ${ACTIVE_CHECKOUT_INDEX} missing; refusing to drop ${LEGACY_ACTIVE_CHECKOUT_INDEX}`);
  }
  try {
    await coll.dropIndex(LEGACY_ACTIVE_CHECKOUT_INDEX);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 27 && code !== 26) throw e; // IndexNotFound / NamespaceNotFound: another instance won
  }
}

export * from './cart.js';
export * from './checkout-group.js';
export * from './child-order.js';
export * from './order-event.js';
export * from './restaurant-projection.js';
export * from './support-ticket.js';
export * from './common.js';
