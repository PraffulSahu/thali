/** Event catalog (LLD 1.6, 9). Every payload is typed; envelope carries the dedupe id. */
import type { Actor } from './state-machines.js';
import type {
  ChildOrderStatus,
  PaymentPurpose,
  RefundReason,
  RefundStatus,
  RestaurantStatus,
  PartnerStatus,
  Role,
  ServiceName,
  VehicleType,
} from './enums.js';
import type { Breakdown } from './schemas/order.js';
import type { GeoJsonPoint } from './schemas/common.js';

/** Pickup/drop snapshots carried on `order.accepted`. */
export interface EventPickup {
  name: string;
  address: string;
  location: GeoJsonPoint;
}
export interface EventDrop extends EventPickup {
  phoneMasked: string;
}

export interface RefundEventPayload {
  refundId: string;
  childOrderId?: string;
  checkoutGroupId: string;
  amountPaise: number;
  reason: RefundReason;
  status: RefundStatus;
}

export interface DeliveryAtPayload {
  jobId: string;
  childOrderId: string;
  partnerUserId: string;
  at: string;
}

export interface EventPayloads {
  // identity
  'user.registered': { userId: string; phone: string };
  'role.granted': { userId: string; role: Role };
  /** producer: any service */
  'audit.recorded': {
    actorId: string;
    actorRole: string;
    action: string;
    targetType: string;
    targetId: string;
    summary: string;
    ip?: string;
    service: ServiceName;
  };

  // marketplace
  'restaurant.submitted': { restaurantId: string; ownerUserId: string };
  /** `verifyUrl` contains the raw token: notifications must never log it. */
  'restaurant.email_verification_requested': { restaurantId: string; email: string; verifyUrl: string };
  'restaurant.status_changed': {
    restaurantId: string;
    ownerUserId: string;
    name: string;
    from: RestaurantStatus;
    to: RestaurantStatus;
    reason?: string;
    location: GeoJsonPoint;
  };
  'restaurant.updated': {
    restaurantId: string;
    ownerUserId: string;
    name: string;
    status: RestaurantStatus;
    location: GeoJsonPoint;
  };
  'membership.activated': { membershipId: string; userId: string; planId: string; endsAt: string };

  // orders: checkout
  'checkout.created': { checkoutId: string; userId: string; totalPaise: number; childOrderIds: string[] };
  'checkout.confirmed': { checkoutId: string; userId: string; childOrderIds: string[] };
  'checkout.released': { checkoutId: string; reason: 'PAYMENT_FAILED' | 'EXPIRED' };
  'checkout.late_payment': { checkoutId: string; paymentIntentId?: string; amountPaise: number };

  // orders: child orders
  'order.placed': {
    childOrderId: string;
    checkoutId: string;
    userId: string;
    restaurantId: string;
    restaurantOwnerId: string;
    code: string;
    totalPaise: number;
    acceptBy: string;
  };
  'order.accepted': {
    childOrderId: string;
    checkoutId: string;
    userId: string;
    restaurantId: string;
    prepMinutes: number;
    pickup: EventPickup;
    drop: EventDrop;
    pickupCode: string;
    deliveryCode: string;
  };
  'order.rejected': {
    childOrderId: string;
    checkoutId: string;
    userId: string;
    restaurantId: string;
    reason: string;
    refundPaise: number;
    /** Child status before the transition (orders always sets it; optional for events published before it existed). */
    fromStatus?: ChildOrderStatus;
  };
  'order.cancelled': {
    childOrderId: string;
    checkoutId: string;
    userId: string;
    restaurantId: string;
    actor: Actor;
    reason: string;
    refundPaise: number;
    /** Child status before the cancellation: marketplace restocks only when cancelled before PREPARING. */
    fromStatus?: ChildOrderStatus;
  };
  'order.preparing': { childOrderId: string; restaurantId: string; userId: string };
  'order.ready': { childOrderId: string; restaurantId: string; userId: string };
  'order.picked_up': { childOrderId: string; userId: string };
  'order.out_for_delivery': { childOrderId: string; userId: string };
  'order.delivered': {
    childOrderId: string;
    checkoutId: string;
    userId: string;
    restaurantId: string;
    restaurantOwnerId: string;
    breakdown: Breakdown;
    commissionBps: number;
    deliveryJobId: string;
    partnerUserId: string;
    deliveryDistanceKm: number;
  };
  'order.delivery_failed': { childOrderId: string; reason: string };

  // payments
  'payment.captured': {
    paymentIntentId: string;
    purpose: PaymentPurpose;
    referenceId: string;
    userId: string;
    amountPaise: number;
    providerPaymentId: string;
  };
  'payment.failed': {
    paymentIntentId: string;
    purpose: PaymentPurpose;
    referenceId: string;
    userId: string;
    reason: string;
  };
  'refund.requested': RefundEventPayload;
  'refund.processing': RefundEventPayload;
  'refund.succeeded': RefundEventPayload;
  'refund.failed': RefundEventPayload;

  // delivery
  'delivery.job_created': { jobId: string; childOrderId: string };
  'delivery.assigned': {
    jobId: string;
    childOrderId: string;
    partnerId: string;
    partnerUserId: string;
    partnerName: string;
    vehicle: { type: VehicleType; registrationNumber: string };
  };
  'delivery.unassigned': { jobId: string; childOrderId: string; reason: string };
  'delivery.picked_up': DeliveryAtPayload;
  'delivery.started': DeliveryAtPayload;
  'delivery.delivered': DeliveryAtPayload & { distanceKm: number };
  'delivery.failed': { jobId: string; childOrderId: string; reason: string };
  'delivery.exception': { jobId: string; childOrderId: string; reason: string };
  'partner.status_changed': {
    partnerId: string;
    userId: string;
    from: PartnerStatus;
    to: PartnerStatus;
    reason?: string;
  };
}

export type EventType = keyof EventPayloads;

/** All event types as a runtime list. Kept in sync with `EventPayloads` by the compiler (Record below). */
const eventTypeMap: Record<EventType, true> = {
  'user.registered': true,
  'role.granted': true,
  'audit.recorded': true,
  'restaurant.submitted': true,
  'restaurant.email_verification_requested': true,
  'restaurant.status_changed': true,
  'restaurant.updated': true,
  'membership.activated': true,
  'checkout.created': true,
  'checkout.confirmed': true,
  'checkout.released': true,
  'checkout.late_payment': true,
  'order.placed': true,
  'order.accepted': true,
  'order.rejected': true,
  'order.cancelled': true,
  'order.preparing': true,
  'order.ready': true,
  'order.picked_up': true,
  'order.out_for_delivery': true,
  'order.delivered': true,
  'order.delivery_failed': true,
  'payment.captured': true,
  'payment.failed': true,
  'refund.requested': true,
  'refund.processing': true,
  'refund.succeeded': true,
  'refund.failed': true,
  'delivery.job_created': true,
  'delivery.assigned': true,
  'delivery.unassigned': true,
  'delivery.picked_up': true,
  'delivery.started': true,
  'delivery.delivered': true,
  'delivery.failed': true,
  'delivery.exception': true,
  'partner.status_changed': true,
};
export const EventTypes = Object.keys(eventTypeMap) as EventType[];

export interface EventEnvelope<T extends EventType = EventType> {
  /** uuid v4 - dedupe key */
  id: string;
  type: T;
  version: 1;
  /** ISO-8601 */
  occurredAt: string;
  producer: ServiceName;
  correlationId: string;
  /** e.g. childOrderId */
  aggregateId: string;
  payload: EventPayloads[T];
}

/** Redis stream names (`events.<producer>`); services that publish events. */
export const EVENT_STREAMS = {
  identity: 'events.identity',
  marketplace: 'events.marketplace',
  orders: 'events.orders',
  payments: 'events.payments',
  delivery: 'events.delivery',
  /** notifications produces only `audit.recorded`. */
  notifications: 'events.notifications',
} as const;
export type EventStreamService = keyof typeof EVENT_STREAMS;
export type EventStream = (typeof EVENT_STREAMS)[EventStreamService];

export function eventStream(producer: EventStreamService): EventStream {
  return EVENT_STREAMS[producer];
}
/** Consumer group (`cg.<service>`) and DLQ stream (`dlq.<service>`) names. */
export const consumerGroup = (service: ServiceName): string => `cg.${service}`;
export const dlqStream = (service: ServiceName): string => `dlq.${service}`;

/** Producing service per event type; `null` = any service (audit.recorded). */
const producerByPrefix: Record<string, ServiceName> = {
  user: 'identity',
  role: 'identity',
  restaurant: 'marketplace',
  membership: 'marketplace',
  checkout: 'orders',
  order: 'orders',
  payment: 'payments',
  refund: 'payments',
  delivery: 'delivery',
  partner: 'delivery',
};
export function eventProducer(type: EventType): ServiceName | null {
  if (type === 'audit.recorded') return null;
  return producerByPrefix[type.split('.')[0]!]!;
}
