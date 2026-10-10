/**
 * Shared enums as `const` objects + union types (LLD 2.1, 3, 4).
 * Usage: `ChildOrderStatus.PLACED` (value) and `ChildOrderStatus` (type).
 */

/** Typed list of an enum object's values (useful for `z.enum(...)`). */
export function enumValues<T extends Record<string, string>>(o: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(o) as [T[keyof T], ...T[keyof T][]];
}

export const Role = {
  CONSUMER: 'CONSUMER',
  RESTAURANT_OWNER: 'RESTAURANT_OWNER',
  DELIVERY_PARTNER: 'DELIVERY_PARTNER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  OPS: 'OPS',
  FINANCE: 'FINANCE',
  SUPPORT: 'SUPPORT',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const AppMode = {
  demo: 'demo',
  sandbox: 'sandbox',
  production: 'production',
} as const;
export type AppMode = (typeof AppMode)[keyof typeof AppMode];

export const ServiceName = {
  gateway: 'gateway',
  identity: 'identity',
  marketplace: 'marketplace',
  orders: 'orders',
  payments: 'payments',
  delivery: 'delivery',
  notifications: 'notifications',
} as const;
export type ServiceName = (typeof ServiceName)[keyof typeof ServiceName];

export const RestaurantStatus = {
  DRAFT: 'DRAFT',
  VERIFICATION_PENDING: 'VERIFICATION_PENDING',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type RestaurantStatus = (typeof RestaurantStatus)[keyof typeof RestaurantStatus];

export const PartnerStatus = {
  DRAFT: 'DRAFT',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type PartnerStatus = (typeof PartnerStatus)[keyof typeof PartnerStatus];

export const CheckoutStatus = {
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAID_PLACED: 'PAID_PLACED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  CANCELLED: 'CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

export const ChildOrderStatus = {
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PLACED: 'PLACED',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;
export type ChildOrderStatus = (typeof ChildOrderStatus)[keyof typeof ChildOrderStatus];

export const PaymentStatus = {
  CREATED: 'CREATED',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentPurpose = {
  CHECKOUT: 'CHECKOUT',
  MEMBERSHIP: 'MEMBERSHIP',
} as const;
export type PaymentPurpose = (typeof PaymentPurpose)[keyof typeof PaymentPurpose];

export const RefundStatus = {
  REQUESTED: 'REQUESTED',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

/** Child order `refundStatus` = RefundStatus plus `NONE`. */
export const ChildRefundStatus = {
  NONE: 'NONE',
  ...RefundStatus,
} as const;
export type ChildRefundStatus = (typeof ChildRefundStatus)[keyof typeof ChildRefundStatus];

export const RefundReason = {
  RESTAURANT_REJECTED: 'RESTAURANT_REJECTED',
  RESTAURANT_TIMEOUT: 'RESTAURANT_TIMEOUT',
  CUSTOMER_CANCELLED: 'CUSTOMER_CANCELLED',
  ADMIN: 'ADMIN',
  LATE_PAYMENT: 'LATE_PAYMENT',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
} as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];

export const DeliveryStatus = {
  PENDING_ASSIGNMENT: 'PENDING_ASSIGNMENT',
  OFFERED: 'OFFERED',
  ASSIGNED: 'ASSIGNED',
  AT_PICKUP: 'AT_PICKUP',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const OfferStatus = {
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type OfferStatus = (typeof OfferStatus)[keyof typeof OfferStatus];

export const EstimateSource = {
  GOOGLE: 'GOOGLE',
  DEMO_HAVERSINE: 'DEMO_HAVERSINE',
  HAVERSINE_FALLBACK: 'HAVERSINE_FALLBACK',
} as const;
export type EstimateSource = (typeof EstimateSource)[keyof typeof EstimateSource];

export const NotificationStatus = {
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

export const NotificationChannel = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  IN_APP: 'IN_APP',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const TicketStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const TicketCategory = {
  ORDER_ISSUE: 'ORDER_ISSUE',
  PAYMENT: 'PAYMENT',
  DELIVERY: 'DELIVERY',
  ACCOUNT: 'ACCOUNT',
  OTHER: 'OTHER',
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

export const LedgerAccountType = {
  RESTAURANT: 'RESTAURANT',
  PARTNER: 'PARTNER',
  PLATFORM: 'PLATFORM',
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

export const LedgerEntryType = {
  ORDER_EARNING: 'ORDER_EARNING',
  COMMISSION: 'COMMISSION',
  REFUND_ADJUSTMENT: 'REFUND_ADJUSTMENT',
  DELIVERY_EARNING: 'DELIVERY_EARNING',
  PAYOUT: 'PAYOUT',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
} as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export const PayoutStatus = {
  REQUESTED: 'REQUESTED',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const VehicleType = {
  BIKE: 'BIKE',
  SCOOTER: 'SCOOTER',
  BICYCLE: 'BICYCLE',
  CAR: 'CAR',
} as const;
export type VehicleType = (typeof VehicleType)[keyof typeof VehicleType];

/** Currency constant (LLD 1.1). */
export const CURRENCY = 'INR' as const;
export type Currency = typeof CURRENCY;
