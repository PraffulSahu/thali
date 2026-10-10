import { describe, expect, it } from 'vitest';
import {
  AddressSchema,
  BreakdownSchema,
  CartItemInputSchema,
  ErrorEnvelopeSchema,
  GeoPointSchema,
  IdempotencyKeySchema,
  MoneySchema,
  PaginationQuerySchema,
  paginatedSchema,
  toGeoJsonPoint,
  fromGeoJsonPoint,
} from '../src/index.js';
import { z } from 'zod';

const oid = 'a'.repeat(24);

describe('schemas', () => {
  it('GeoPointSchema bounds lat/lng; GeoJSON helpers use [lng, lat]', () => {
    expect(GeoPointSchema.safeParse({ lat: 12.9, lng: 77.6 }).success).toBe(true);
    expect(GeoPointSchema.safeParse({ lat: 91, lng: 0 }).success).toBe(false);
    expect(GeoPointSchema.safeParse({ lat: 0, lng: 181 }).success).toBe(false);
    expect(toGeoJsonPoint({ lat: 12.9, lng: 77.6 })).toEqual({ type: 'Point', coordinates: [77.6, 12.9] });
    expect(fromGeoJsonPoint({ type: 'Point', coordinates: [77.6, 12.9] })).toEqual({ lat: 12.9, lng: 77.6 });
  });

  it('MoneySchema requires integer non-negative paise', () => {
    expect(MoneySchema.safeParse({ amountPaise: 100, currency: 'INR' }).success).toBe(true);
    expect(MoneySchema.parse({ amountPaise: 100 }).currency).toBe('INR');
    expect(MoneySchema.safeParse({ amountPaise: 10.5 }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountPaise: -1 }).success).toBe(false);
  });

  it('AddressSchema validates pincode and location', () => {
    const ok = { line1: '1 MG Road', city: 'Bengaluru', pincode: '560001', location: { lat: 12.97, lng: 77.59 } };
    expect(AddressSchema.safeParse(ok).success).toBe(true);
    expect(AddressSchema.safeParse({ ...ok, pincode: '12345' }).success).toBe(false);
    expect(AddressSchema.safeParse({ ...ok, line1: '' }).success).toBe(false);
  });

  it('CartItemInputSchema: selections {groupId, optionIds[]}, quantity 1-20', () => {
    const ok = CartItemInputSchema.parse({
      restaurantId: oid,
      itemId: oid,
      quantity: 2,
      selections: [{ groupId: oid, optionIds: [oid] }],
    });
    expect(ok.selections).toHaveLength(1);
    expect(CartItemInputSchema.parse({ restaurantId: oid, itemId: oid, quantity: 1 }).selections).toEqual([]);
    expect(CartItemInputSchema.safeParse({ restaurantId: oid, itemId: oid, quantity: 0 }).success).toBe(false);
    expect(CartItemInputSchema.safeParse({ restaurantId: oid, itemId: oid, quantity: 21 }).success).toBe(false);
    expect(CartItemInputSchema.safeParse({ restaurantId: 'x', itemId: oid, quantity: 1 }).success).toBe(false);
  });

  it('PaginationQuerySchema coerces and caps limit', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(PaginationQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({ limit: 50, cursor: 'abc' });
    expect(PaginationQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    const page = paginatedSchema(z.object({ id: z.string() }));
    expect(page.safeParse({ items: [{ id: '1' }], nextCursor: null }).success).toBe(true);
  });

  it('ErrorEnvelopeSchema matches LLD 1.2', () => {
    expect(
      ErrorEnvelopeSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } }).success,
    ).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success).toBe(false);
  });

  it('BreakdownSchema has all 10 fields as integers', () => {
    const b = {
      itemsSubtotalPaise: 1, couponDiscountPaise: 0, membershipDiscountPaise: 0, packagingFeePaise: 0,
      deliveryFeePaise: 0, deliveryDiscountPaise: 0, platformFeePaise: 0, foodTaxPaise: 0, feeTaxPaise: 0, totalPaise: 1,
    };
    expect(BreakdownSchema.safeParse(b).success).toBe(true);
    expect(BreakdownSchema.safeParse({ ...b, totalPaise: 1.5 }).success).toBe(false);
    expect(BreakdownSchema.safeParse({ ...b, totalPaise: undefined }).success).toBe(false);
  });

  it('IdempotencyKeySchema enforces 8-128 chars [A-Za-z0-9_-]', () => {
    expect(IdempotencyKeySchema.safeParse('abcd1234').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('has space 123').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});
