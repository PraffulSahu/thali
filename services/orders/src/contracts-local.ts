/**
 * Orders-side strictness on top of `@thali/contracts` event payloads.
 *
 * `fromStatus` (the child status before the rejection/cancellation) now lives in `@thali/contracts`
 * EventPayloads (optional there, for events published before it existed); orders always sets it, so the
 * payloads it emits require it.
 */
import type { EventPayloads } from '@thali/contracts';

export type OrderRejectedPayload = EventPayloads['order.rejected'] & Required<Pick<EventPayloads['order.rejected'], 'fromStatus'>>;
export type OrderCancelledPayload = EventPayloads['order.cancelled'] & Required<Pick<EventPayloads['order.cancelled'], 'fromStatus'>>;
