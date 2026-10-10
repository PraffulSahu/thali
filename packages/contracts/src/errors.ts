/**
 * Error codes + HTTP status map (LLD 1.2) and `DomainError`.
 * Envelope on the wire: `{ error: { code, message, details?, requestId } }`.
 */

/** Single source of truth: ErrorCode -> default HTTP status. */
export const ERROR_STATUS = {
  // --- generic ---
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONCURRENT_MODIFICATION: 409, // optimistic-concurrency (mongoose VersionError) conflict
  PAYLOAD_TOO_LARGE: 413, // request body over the JSON limit
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  INVALID_TRANSITION: 409, // generic fallback for unregistered state tables

  // --- auth / session (identity, service-kit) ---
  INVALID_CREDENTIALS: 401,
  SESSION_REVOKED: 401,
  SESSION_REUSE_DETECTED: 401,
  CSRF_CHECK_FAILED: 403,
  MFA_REQUIRED: 403,
  ACCOUNT_BLOCKED: 403,
  ACCOUNT_LOCKED: 423,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  OTP_ATTEMPTS_EXCEEDED: 429,
  OTP_DELIVERY_FAILED: 503,

  // --- idempotency ---
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,

  // --- state machines (one per entity) ---
  ORDER_INVALID_TRANSITION: 409,
  CHECKOUT_INVALID_TRANSITION: 409,
  PAYMENT_INVALID_TRANSITION: 409,
  REFUND_INVALID_TRANSITION: 409,
  DELIVERY_INVALID_TRANSITION: 409,
  RESTAURANT_INVALID_TRANSITION: 409,
  PARTNER_INVALID_TRANSITION: 409,
  ORDER_ACCEPT_WINDOW_EXPIRED: 409,

  // --- cart / checkout / marketplace business rules ---
  CART_EMPTY: 422,
  NOT_SERVICEABLE: 422,
  RESTAURANT_CLOSED: 422,
  ITEM_UNAVAILABLE: 422,
  INVALID_SELECTION: 422,
  OUT_OF_STOCK: 409,
  PRICE_CHANGED: 422,
  COUPON_INVALID: 422,
  COUPON_LIMIT_REACHED: 422,
  FILE_INVALID: 422,

  // --- payments ---
  PAYMENT_PROVIDER_UNAVAILABLE: 502,
  WEBHOOK_SIGNATURE_INVALID: 400,
  REFUND_EXCEEDS_CAPTURED: 422,
  REFUND_EXCEEDS_REMAINING: 422,
  REFUND_TARGET_MISMATCH: 422, // manual refund's child/restaurant does not belong to the payment

  // --- delivery ---
  ASSIGNMENT_TAKEN: 409,
  OFFER_EXPIRED: 409,
  CAPACITY_EXCEEDED: 409,
  PARTNER_NOT_APPROVED: 403,
  DELIVERY_CODE_INVALID: 400,
  DELIVERY_CODE_LOCKED: 423,

  // --- upstream / infrastructure ---
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** `ErrorCode.NOT_FOUND === 'NOT_FOUND'` — const object + union type of the same name. */
export const ErrorCode = Object.fromEntries(Object.keys(ERROR_STATUS).map((k) => [k, k])) as {
  readonly [K in ErrorCode]: K;
};

/** Default HTTP status for a code. */
export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus?: number, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus ?? ERROR_STATUS[code];
    if (details !== undefined) this.details = details;
  }

  /** Envelope body minus `requestId` (added by the error handler). */
  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
