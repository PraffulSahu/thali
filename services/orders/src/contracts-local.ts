/**
 * Local additive extensions of `@thali/contracts` event payloads (Phase 1 rule: define locally,
 * reconcile after the wave — listed under "Contract gaps" in the Task 12 report).
 *
 * `fromStatus`: the child status before the rejection/cancellation, so marketplace can restock only
 * when an order was cancelled before PREPARING (LLD §9 `order.cancelled` → marketplace restock).
 */
import type { ChildOrderStatus, EventPayloads } from '@thali/contracts';

export type OrderRejectedPayload = EventPayloads['order.rejected'] & { fromStatus: ChildOrderStatus };
export type OrderCancelledPayload = EventPayloads['order.cancelled'] & { fromStatus: ChildOrderStatus };
