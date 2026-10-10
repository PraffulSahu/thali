import { describe, expect, it } from 'vitest';
import { DomainError, ErrorCode, errorStatus } from '../src/index.js';

describe('DomainError', () => {
  it('derives default status from the code map', () => {
    expect(new DomainError('NOT_FOUND', 'x').httpStatus).toBe(404);
    expect(new DomainError('OUT_OF_STOCK', 'x').httpStatus).toBe(409);
    expect(new DomainError('NOT_SERVICEABLE', 'x').httpStatus).toBe(422);
    expect(new DomainError('RATE_LIMITED', 'x').httpStatus).toBe(429);
    expect(new DomainError('VALIDATION_FAILED', 'x').httpStatus).toBe(400);
    expect(new DomainError('UNAUTHENTICATED', 'x').httpStatus).toBe(401);
    expect(new DomainError('FORBIDDEN', 'x').httpStatus).toBe(403);
  });

  it('allows an explicit status override and carries details', () => {
    const e = new DomainError('NOT_FOUND', 'gone', 410, { id: 1 });
    expect(e.httpStatus).toBe(410);
    expect(e.details).toEqual({ id: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DomainError');
    expect(e.message).toBe('gone');
    expect(e.code).toBe('NOT_FOUND');
  });

  it('has a status for every code and every *_INVALID_TRANSITION is 409', () => {
    for (const code of Object.values(ErrorCode)) {
      const s = errorStatus(code);
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(600);
      if (code.endsWith('_INVALID_TRANSITION')) expect(s).toBe(409);
    }
  });

  it('maps the codes named in the plan to documented statuses', () => {
    const expected: Record<string, number> = {
      IDEMPOTENCY_CONFLICT: 409,
      IDEMPOTENCY_IN_PROGRESS: 409,
      IDEMPOTENCY_KEY_REQUIRED: 400,
      PRICE_CHANGED: 422,
      RESTAURANT_CLOSED: 422,
      COUPON_INVALID: 422,
      ASSIGNMENT_TAKEN: 409,
      OFFER_EXPIRED: 409,
      CAPACITY_EXCEEDED: 409,
      PARTNER_NOT_APPROVED: 403,
      MFA_REQUIRED: 403,
      SESSION_REVOKED: 401,
      SESSION_REUSE_DETECTED: 401,
      CSRF_CHECK_FAILED: 403,
      ACCOUNT_LOCKED: 423,
      OTP_EXPIRED: 400,
      OTP_INVALID: 400,
      OTP_ATTEMPTS_EXCEEDED: 429,
      OTP_DELIVERY_FAILED: 503,
      FILE_INVALID: 422,
      REFUND_EXCEEDS_CAPTURED: 422,
      REFUND_EXCEEDS_REMAINING: 422,
      REFUND_TARGET_MISMATCH: 422,
      UPSTREAM_TIMEOUT: 504,
      UPSTREAM_UNAVAILABLE: 502,
      PAYMENT_PROVIDER_UNAVAILABLE: 502,
      ORDER_ACCEPT_WINDOW_EXPIRED: 409,
      CART_EMPTY: 422,
      COUPON_LIMIT_REACHED: 422,
      ITEM_UNAVAILABLE: 422,
      INVALID_SELECTION: 422,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(ErrorCode).toHaveProperty(code, code);
      expect(errorStatus(code as keyof typeof ErrorCode)).toBe(status);
    }
  });

  it('serializes to the envelope body (without requestId)', () => {
    const e = new DomainError('CART_EMPTY', 'Cart is empty', undefined, { a: 1 });
    expect(e.toJSON()).toEqual({ code: 'CART_EMPTY', message: 'Cart is empty', details: { a: 1 } });
  });
});
