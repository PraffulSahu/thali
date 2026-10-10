import { describe, expect, it } from 'vitest';
import { type CheckoutStatus, type ChildOrderStatus, deriveCheckoutStatus } from '../src/index.js';

const cases: [ChildOrderStatus[], CheckoutStatus][] = [
  [['DELIVERED', 'DELIVERED'], 'COMPLETED'],
  [['DELIVERED', 'REJECTED'], 'PARTIALLY_COMPLETED'],
  [['DELIVERED', 'CANCELLED', 'REJECTED'], 'PARTIALLY_COMPLETED'],
  [['REJECTED', 'CANCELLED'], 'CANCELLED'],
  [['CANCELLED'], 'CANCELLED'],
  [['PLACED', 'PLACED'], 'PAID_PLACED'],
  [['PLACED'], 'PAID_PLACED'],
  [['ACCEPTED', 'REJECTED'], 'IN_PROGRESS'],
  [['PLACED', 'ACCEPTED'], 'IN_PROGRESS'],
  [['PLACED', 'REJECTED'], 'IN_PROGRESS'],
  [['PREPARING', 'OUT_FOR_DELIVERY'], 'IN_PROGRESS'],
  [['PAYMENT_FAILED', 'PAYMENT_FAILED'], 'PAYMENT_FAILED'],
  [['EXPIRED'], 'EXPIRED'],
  [['EXPIRED', 'EXPIRED'], 'EXPIRED'],
  [['DELIVERY_FAILED', 'DELIVERED'], 'IN_PROGRESS'],
  [['DELIVERY_FAILED'], 'IN_PROGRESS'],
  [['AWAITING_PAYMENT', 'AWAITING_PAYMENT'], 'AWAITING_PAYMENT'],
  [['AWAITING_PAYMENT', 'PLACED'], 'AWAITING_PAYMENT'],
];

describe('deriveCheckoutStatus', () => {
  it.each(cases)('%j -> %s', (children, expected) => {
    expect(deriveCheckoutStatus(children, 'AWAITING_PAYMENT')).toBe(expected);
  });

  it('is independent of the current status for non-empty children', () => {
    expect(deriveCheckoutStatus(['DELIVERED', 'DELIVERED'], 'IN_PROGRESS')).toBe('COMPLETED');
  });

  it('returns current when there are no children', () => {
    expect(deriveCheckoutStatus([], 'PAID_PLACED')).toBe('PAID_PLACED');
  });
});
