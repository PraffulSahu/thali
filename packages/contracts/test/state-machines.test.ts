import { describe, expect, it } from 'vitest';
import {
  type Actor,
  ChildOrderStatus,
  CheckoutStatus,
  DeliveryStatus,
  DomainError,
  PartnerStatus,
  PaymentStatus,
  RefundStatus,
  RestaurantStatus,
  type Transition,
  allowedTransitions,
  assertTransition,
  canTransition,
  checkoutTransitions,
  childOrderTransitions,
  deliveryTransitions,
  isTerminalState,
  partnerTransitions,
  paymentTransitions,
  refundTransitions,
  restaurantTransitions,
} from '../src/index.js';

const ALL_ACTORS: Actor[] = ['CUSTOMER', 'RESTAURANT', 'PARTNER', 'ADMIN', 'SYSTEM'];

type Row<S extends string> = [from: S, to: S, actors: Actor[]];

interface Spec<S extends string> {
  name: string;
  table: Transition<S>[];
  states: readonly S[];
  rows: Row<S>[];
  terminal: S[];
  code: string;
}

const values = <T extends Record<string, string>>(o: T) => Object.values(o) as T[keyof T][];

// Independent transcription of LLD section 4 (one row per from->to pair).
const specs: Spec<string>[] = [
  {
    name: 'childOrder (LLD 4.1)',
    table: childOrderTransitions,
    states: values(ChildOrderStatus),
    code: 'ORDER_INVALID_TRANSITION',
    terminal: ['DELIVERED', 'REJECTED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'],
    rows: [
      ['AWAITING_PAYMENT', 'PLACED', ['SYSTEM']],
      ['AWAITING_PAYMENT', 'PAYMENT_FAILED', ['SYSTEM']],
      ['AWAITING_PAYMENT', 'EXPIRED', ['SYSTEM']],
      ['PLACED', 'ACCEPTED', ['RESTAURANT', 'ADMIN']],
      ['PLACED', 'REJECTED', ['RESTAURANT', 'SYSTEM', 'ADMIN']],
      ['PLACED', 'CANCELLED', ['CUSTOMER', 'ADMIN']],
      ['ACCEPTED', 'PREPARING', ['RESTAURANT']],
      ['ACCEPTED', 'READY_FOR_PICKUP', ['RESTAURANT']],
      ['PREPARING', 'READY_FOR_PICKUP', ['RESTAURANT']],
      ['ACCEPTED', 'CANCELLED', ['ADMIN']],
      ['PREPARING', 'CANCELLED', ['ADMIN']],
      ['READY_FOR_PICKUP', 'CANCELLED', ['ADMIN']],
      ['READY_FOR_PICKUP', 'PICKED_UP', ['SYSTEM']],
      ['ACCEPTED', 'PICKED_UP', ['SYSTEM']],
      ['PREPARING', 'PICKED_UP', ['SYSTEM']],
      ['PICKED_UP', 'OUT_FOR_DELIVERY', ['SYSTEM']],
      ['OUT_FOR_DELIVERY', 'DELIVERED', ['SYSTEM']],
      ['PICKED_UP', 'DELIVERED', ['SYSTEM']],
      ['PICKED_UP', 'DELIVERY_FAILED', ['SYSTEM', 'ADMIN']],
      ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED', ['SYSTEM', 'ADMIN']],
      ['DELIVERY_FAILED', 'CANCELLED', ['ADMIN']],
    ],
  },
  {
    name: 'checkout (LLD 4.2)',
    table: checkoutTransitions,
    states: values(CheckoutStatus),
    code: 'CHECKOUT_INVALID_TRANSITION',
    terminal: ['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'],
    rows: [
      ['AWAITING_PAYMENT', 'PAID_PLACED', ['SYSTEM']],
      ['AWAITING_PAYMENT', 'PAYMENT_FAILED', ['SYSTEM']],
      ['AWAITING_PAYMENT', 'EXPIRED', ['SYSTEM']],
      ['PAID_PLACED', 'IN_PROGRESS', ['SYSTEM']],
      ['PAID_PLACED', 'COMPLETED', ['SYSTEM']],
      ['PAID_PLACED', 'PARTIALLY_COMPLETED', ['SYSTEM']],
      ['PAID_PLACED', 'CANCELLED', ['SYSTEM']],
      ['IN_PROGRESS', 'COMPLETED', ['SYSTEM']],
      ['IN_PROGRESS', 'PARTIALLY_COMPLETED', ['SYSTEM']],
      ['IN_PROGRESS', 'CANCELLED', ['SYSTEM']],
    ],
  },
  {
    name: 'payment (LLD 4.3)',
    table: paymentTransitions,
    states: values(PaymentStatus),
    code: 'PAYMENT_INVALID_TRANSITION',
    terminal: ['FAILED', 'REFUNDED'],
    rows: [
      ['CREATED', 'AUTHORIZED', ['SYSTEM']],
      ['AUTHORIZED', 'CAPTURED', ['SYSTEM']],
      ['CREATED', 'FAILED', ['SYSTEM']],
      ['AUTHORIZED', 'FAILED', ['SYSTEM']],
      ['CAPTURED', 'PARTIALLY_REFUNDED', ['SYSTEM']],
      ['PARTIALLY_REFUNDED', 'REFUNDED', ['SYSTEM']],
      ['CAPTURED', 'REFUNDED', ['SYSTEM']],
    ],
  },
  {
    name: 'refund (LLD 4.4)',
    table: refundTransitions,
    states: values(RefundStatus),
    code: 'REFUND_INVALID_TRANSITION',
    terminal: ['SUCCEEDED'],
    rows: [
      ['REQUESTED', 'PROCESSING', ['SYSTEM']],
      ['PROCESSING', 'SUCCEEDED', ['SYSTEM']],
      ['PROCESSING', 'FAILED', ['SYSTEM']],
      ['FAILED', 'PROCESSING', ['SYSTEM', 'ADMIN']],
      ['REQUESTED', 'FAILED', ['SYSTEM']],
    ],
  },
  {
    name: 'delivery (LLD 4.5)',
    table: deliveryTransitions,
    states: values(DeliveryStatus),
    code: 'DELIVERY_INVALID_TRANSITION',
    terminal: ['DELIVERED', 'FAILED', 'CANCELLED'],
    rows: [
      ['PENDING_ASSIGNMENT', 'OFFERED', ['SYSTEM']],
      ['PENDING_ASSIGNMENT', 'ASSIGNED', ['PARTNER', 'ADMIN']],
      ['OFFERED', 'ASSIGNED', ['PARTNER', 'ADMIN']],
      ['OFFERED', 'PENDING_ASSIGNMENT', ['SYSTEM']],
      ['ASSIGNED', 'AT_PICKUP', ['PARTNER']],
      ['ASSIGNED', 'PENDING_ASSIGNMENT', ['PARTNER', 'ADMIN', 'SYSTEM']],
      ['AT_PICKUP', 'PENDING_ASSIGNMENT', ['PARTNER', 'ADMIN', 'SYSTEM']],
      ['AT_PICKUP', 'PICKED_UP', ['PARTNER']],
      ['PICKED_UP', 'OUT_FOR_DELIVERY', ['PARTNER']],
      ['OUT_FOR_DELIVERY', 'DELIVERED', ['PARTNER']],
      ['PICKED_UP', 'FAILED', ['PARTNER', 'ADMIN']],
      ['OUT_FOR_DELIVERY', 'FAILED', ['PARTNER', 'ADMIN']],
      ['PENDING_ASSIGNMENT', 'CANCELLED', ['SYSTEM', 'ADMIN']],
      ['OFFERED', 'CANCELLED', ['SYSTEM', 'ADMIN']],
      ['ASSIGNED', 'CANCELLED', ['SYSTEM', 'ADMIN']],
      ['AT_PICKUP', 'CANCELLED', ['SYSTEM', 'ADMIN']],
      ['PICKED_UP', 'CANCELLED', ['SYSTEM', 'ADMIN']],
      ['OUT_FOR_DELIVERY', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ],
  },
  {
    name: 'restaurant (LLD 4.6)',
    table: restaurantTransitions,
    states: values(RestaurantStatus),
    code: 'RESTAURANT_INVALID_TRANSITION',
    terminal: [],
    rows: [
      ['DRAFT', 'VERIFICATION_PENDING', ['RESTAURANT']],
      ['VERIFICATION_PENDING', 'APPROVAL_PENDING', ['SYSTEM']],
      ['APPROVAL_PENDING', 'APPROVED', ['ADMIN']],
      ['APPROVAL_PENDING', 'REJECTED', ['ADMIN']],
      ['REJECTED', 'APPROVAL_PENDING', ['RESTAURANT']],
      ['APPROVED', 'SUSPENDED', ['ADMIN']],
      ['SUSPENDED', 'APPROVED', ['ADMIN']],
      // businessEmail changed before approval -> back to verification
      ['APPROVAL_PENDING', 'VERIFICATION_PENDING', ['RESTAURANT']],
      ['REJECTED', 'VERIFICATION_PENDING', ['RESTAURANT']],
    ],
  },
  {
    name: 'partner (LLD 4.7)',
    table: partnerTransitions,
    states: values(PartnerStatus),
    code: 'PARTNER_INVALID_TRANSITION',
    terminal: [],
    rows: [
      ['DRAFT', 'APPROVAL_PENDING', ['PARTNER']],
      ['APPROVAL_PENDING', 'APPROVED', ['ADMIN']],
      ['APPROVAL_PENDING', 'REJECTED', ['ADMIN']],
      ['REJECTED', 'APPROVAL_PENDING', ['PARTNER']],
      ['APPROVED', 'SUSPENDED', ['ADMIN']],
      ['SUSPENDED', 'APPROVED', ['ADMIN']],
    ],
  },
];

describe.each(specs)('$name', (spec) => {
  it('has exactly the specified (from,to) pairs - no more, no fewer', () => {
    const actual = spec.table.map((t) => `${t.from}>${t.to}`).sort();
    const expected = spec.rows.map(([f, t]) => `${f}>${t}`).sort();
    expect(actual).toEqual(expected);
  });

  it.each(spec.rows.map((r) => ({ from: r[0], to: r[1], actors: r[2] })))(
    '$from -> $to allowed for $actors',
    ({ from, to, actors }) => {
      for (const a of actors) {
        expect(canTransition(spec.table, from, to, a)).toBe(true);
        expect(() => assertTransition(spec.table, from, to, a)).not.toThrow();
      }
      const other = ALL_ACTORS.filter((a) => !actors.includes(a));
      expect(other.length).toBeGreaterThan(0);
      for (const a of other) {
        expect(canTransition(spec.table, from, to, a)).toBe(false);
        expect(() => assertTransition(spec.table, from, to, a)).toThrow(DomainError);
      }
    },
  );

  it('rejects every (from,to) pair not in the table for every actor, with the entity error code', () => {
    const listed = new Set(spec.rows.map(([f, t]) => `${f}>${t}`));
    for (const from of spec.states) {
      for (const to of spec.states) {
        if (listed.has(`${from}>${to}`)) continue;
        for (const a of ALL_ACTORS) {
          expect(canTransition(spec.table, from, to, a), `${from}>${to} ${a}`).toBe(false);
        }
      }
    }
    let err: unknown;
    try {
      // a pair that is never listed: a state to itself
      assertTransition(spec.table, spec.states[0]!, spec.states[0]!, 'SYSTEM');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(spec.code);
    expect((err as DomainError).httpStatus).toBe(409);
  });

  it('terminal states have no outgoing transitions; others have at least one', () => {
    for (const s of spec.terminal) {
      expect(spec.table.filter((t) => t.from === s)).toEqual([]);
      expect(isTerminalState(spec.table, s)).toBe(true);
    }
    for (const s of spec.states) {
      if (spec.terminal.includes(s)) continue;
      expect(isTerminalState(spec.table, s), s).toBe(false);
    }
  });
});

describe('child order scenarios from the brief', () => {
  it('PLACED -> DELIVERED by RESTAURANT throws ORDER_INVALID_TRANSITION (409)', () => {
    let err: unknown;
    try {
      assertTransition(childOrderTransitions, 'PLACED', 'DELIVERED', 'RESTAURANT');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('ORDER_INVALID_TRANSITION');
    expect((err as DomainError).httpStatus).toBe(409);
    expect((err as DomainError).details).toMatchObject({ from: 'PLACED', to: 'DELIVERED', actor: 'RESTAURANT' });
  });

  it('RESTAURANT cannot PLACED -> CANCELLED', () => {
    expect(canTransition(childOrderTransitions, 'PLACED', 'CANCELLED', 'RESTAURANT')).toBe(false);
  });

  it('CUSTOMER can PLACED -> CANCELLED but not ACCEPTED -> CANCELLED', () => {
    expect(canTransition(childOrderTransitions, 'PLACED', 'CANCELLED', 'CUSTOMER')).toBe(true);
    expect(canTransition(childOrderTransitions, 'ACCEPTED', 'CANCELLED', 'CUSTOMER')).toBe(false);
  });

  it('an explicit code argument overrides the table code', () => {
    try {
      assertTransition(childOrderTransitions, 'PLACED', 'DELIVERED', 'ADMIN', 'CHECKOUT_INVALID_TRANSITION');
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('CHECKOUT_INVALID_TRANSITION');
    }
  });

  it('allowedTransitions lists reachable targets for an actor', () => {
    expect(allowedTransitions(childOrderTransitions, 'PLACED', 'CUSTOMER')).toEqual(['CANCELLED']);
    expect(allowedTransitions(childOrderTransitions, 'PLACED', 'ADMIN').sort()).toEqual(['ACCEPTED', 'CANCELLED', 'REJECTED']);
  });
});
