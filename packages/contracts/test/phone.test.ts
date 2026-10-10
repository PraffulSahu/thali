import { describe, expect, it } from 'vitest';
import { DomainError, PhoneSchema, normalizePhone } from '../src/index.js';

describe('normalizePhone', () => {
  it.each(['+91 98765 43210', '09876543210', '9876543210', '919876543210', '+91-98765-43210', '  98765 43210 '])(
    'normalizes %j to +919876543210',
    (input) => {
      expect(normalizePhone(input)).toBe('+919876543210');
    },
  );

  it.each(['12345', 'abcdefghij', '+911123456789', '', '+919876543210x12', '98765432101234'])(
    'rejects %j with VALIDATION_FAILED',
    (input) => {
      let err: unknown;
      try {
        normalizePhone(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('VALIDATION_FAILED');
      expect((err as DomainError).httpStatus).toBe(400);
    },
  );

  it('accepts a non-IN mobile with an explicit country code', () => {
    expect(normalizePhone('+44 7400 123456')).toBe('+447400123456');
  });

  it('honours the defaultRegion argument', () => {
    expect(normalizePhone('07400 123456', 'GB')).toBe('+447400123456');
  });

  it('PhoneSchema normalizes valid input and issues a zod error otherwise', () => {
    expect(PhoneSchema.parse('09876543210')).toBe('+919876543210');
    const bad = PhoneSchema.safeParse('12345');
    expect(bad.success).toBe(false);
    expect(PhoneSchema.safeParse(123).success).toBe(false);
  });
});
