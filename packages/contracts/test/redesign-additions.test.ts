import { describe, expect, it } from 'vitest';
import {
  AddressSchema,
  CreateCheckoutBodySchema,
  ERROR_STATUS,
  EventTypes,
  RestaurantAddressSchema,
  RestaurantIdsSubsetSchema,
  SavedAddressSchema,
  eventProducer,
  restaurantSetKey,
  type EventPayloads,
} from '../src/index.js';

const R1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const R2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const addr = { line1: '12th Main Rd', city: 'Bengaluru', pincode: '560038', location: { lat: 12.97, lng: 77.64 } };

describe('UI redesign contract additions', () => {
  it('delivery.arrived is in the catalog, produced by delivery, typed as DeliveryAtPayload', () => {
    expect(EventTypes).toContain('delivery.arrived');
    expect(eventProducer('delivery.arrived')).toBe('delivery');
    const p: EventPayloads['delivery.arrived'] = { jobId: 'j', childOrderId: 'c', partnerUserId: 'u', at: new Date().toISOString() };
    expect(p.jobId).toBe('j');
  });

  it('order.accepted carries order codes, drop area/label and optional pickup phone (compile-time)', () => {
    const p: EventPayloads['order.accepted'] = {
      childOrderId: 'c',
      checkoutId: 'g',
      userId: 'u',
      restaurantId: 'r',
      prepMinutes: 15,
      childOrderCode: 'TH-ABC-1',
      checkoutCode: 'TH-ABC',
      pickup: { name: 'Spice Route', address: '1 MG Rd', location: { type: 'Point', coordinates: [77.6, 12.9] }, phone: '+919876543210' },
      drop: {
        name: 'Prafful',
        address: '12th Main',
        location: { type: 'Point', coordinates: [77.64, 12.97] },
        phoneMasked: '+91 ••••• •3210',
        area: 'Indiranagar',
        label: 'Home',
      },
      pickupCode: '1234',
      deliveryCode: '5678',
    };
    expect(p.drop.area).toBe('Indiranagar');
    // legacy payloads (published before the change) still type-check
    const legacy: EventPayloads['order.accepted'] = { ...p, childOrderCode: undefined, checkoutCode: undefined, drop: { ...p.drop, area: undefined, label: undefined } };
    expect(legacy.drop.area).toBeUndefined();
  });

  it('PURE_VEG_VIOLATION is a 422', () => {
    expect(ERROR_STATUS.PURE_VEG_VIOLATION).toBe(422);
  });

  it('addresses accept optional locality (≤60) and formattedAddress (≤300)', () => {
    expect(AddressSchema.parse({ ...addr, locality: ' Indiranagar ', formattedAddress: '12th Main Rd, Indiranagar, Bengaluru 560038' })).toMatchObject({
      locality: 'Indiranagar',
      formattedAddress: '12th Main Rd, Indiranagar, Bengaluru 560038',
    });
    expect(AddressSchema.parse(addr).locality).toBeUndefined();
    expect(AddressSchema.safeParse({ ...addr, locality: 'x'.repeat(61) }).success).toBe(false);
    expect(AddressSchema.safeParse({ ...addr, formattedAddress: 'x'.repeat(301) }).success).toBe(false);
    expect(SavedAddressSchema.parse({ ...addr, id: 'a1', locality: 'HAL 2nd Stage' }).locality).toBe('HAL 2nd Stage');
  });

  it('restaurant address accepts optional locality (≤60)', () => {
    const r = { line1: '1 MG Rd', city: 'Bengaluru', pincode: '560001' };
    expect(RestaurantAddressSchema.parse({ ...r, locality: 'MG Road' }).locality).toBe('MG Road');
    expect(RestaurantAddressSchema.parse(r).locality).toBeUndefined();
    expect(RestaurantAddressSchema.safeParse({ ...r, locality: 'x'.repeat(61) }).success).toBe(false);
  });

  it('RestaurantIdsSubsetSchema: 1–10 unique ObjectIds', () => {
    expect(RestaurantIdsSubsetSchema.parse([R1, R2])).toEqual([R1, R2]);
    expect(RestaurantIdsSubsetSchema.safeParse([]).success).toBe(false);
    expect(RestaurantIdsSubsetSchema.safeParse(['nope']).success).toBe(false);
    expect(RestaurantIdsSubsetSchema.safeParse([R1, R1]).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(24, '0'));
    expect(RestaurantIdsSubsetSchema.safeParse(eleven).success).toBe(false);
    expect(RestaurantIdsSubsetSchema.safeParse(eleven.slice(0, 10)).success).toBe(true);
  });

  it('checkout body accepts an optional restaurantIds subset', () => {
    expect(CreateCheckoutBodySchema.parse({ addressId: 'a1', restaurantIds: [R1] }).restaurantIds).toEqual([R1]);
    expect(CreateCheckoutBodySchema.parse({ addressId: 'a1' }).restaurantIds).toBeUndefined();
    expect(CreateCheckoutBodySchema.safeParse({ addressId: 'a1', restaurantIds: [] }).success).toBe(false);
  });

  it('restaurantSetKey: sorted, comma-joined; "*" for the whole cart', () => {
    expect(restaurantSetKey(undefined)).toBe('*');
    expect(restaurantSetKey([])).toBe('*');
    expect(restaurantSetKey([R2, R1])).toBe(`${R1},${R2}`);
    expect(restaurantSetKey([R1.toUpperCase()])).toBe(R1);
  });
});
