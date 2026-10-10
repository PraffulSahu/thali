/**
 * Client-side error model.
 *
 * Every failed `api()` call throws an `ApiError`. Server error codes come from the LLD §1.2 envelope
 * `{ error: { code, message, details?, requestId } }` and are treated as OPEN strings: a newer server
 * may send codes this client does not know, so never `switch` exhaustively on them.
 *
 * Client-only codes (never sent by the server):
 *  - `NETWORK_ERROR` (status 0): fetch rejected (offline, DNS, CORS, connection reset).
 *  - `UPSTREAM_UNAVAILABLE` / `HTTP_ERROR`: a non-JSON error body (e.g. nginx 502 HTML page).
 *  - `INVALID_RESPONSE`: a 2xx response whose body was not valid JSON.
 */
import type { ErrorCode } from '@thali/contracts';

/** Known server codes plus any string (open set). */
export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | (string & {});

export interface ApiErrorInit {
  code: ApiErrorCode;
  status: number;
  message: string;
  details?: unknown;
  requestId?: string;
  /** Seconds from the `Retry-After` header or `details.retryAfterSec`. */
  retryAfterSec?: number;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfterSec: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSec = init.retryAfterSec;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 401: the caller has no valid session (expired, revoked, never signed in). */
export function isUnauthenticated(e: unknown): boolean {
  return isApiError(e) && e.status === 401;
}

/** 403: signed in but not allowed (wrong role, MFA missing, blocked, not approved, CSRF). */
export function isForbidden(e: unknown): boolean {
  return isApiError(e) && e.status === 403;
}

export function isNotFound(e: unknown): boolean {
  return isApiError(e) && e.status === 404;
}

export function isNetworkError(e: unknown): boolean {
  return isApiError(e) && e.code === 'NETWORK_ERROR';
}

/** Worth retrying automatically: network failures, 408/429 and 5xx. Never other 4xx. */
export function isRetryable(e: unknown): boolean {
  if (!isApiError(e)) return false;
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

/** Friendly copy for codes users commonly hit. Unknown codes fall back to the server message. */
const FRIENDLY: Record<string, string> = {
  NETWORK_ERROR: "You're offline or the connection dropped. Check your internet and try again.",
  UPSTREAM_UNAVAILABLE: 'This service is temporarily unavailable. Please try again in a moment.',
  UPSTREAM_TIMEOUT: 'The server took too long to respond. Please try again.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again in a moment.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  SESSION_REVOKED: 'You were signed out. Please sign in again.',
  SESSION_REUSE_DETECTED: 'For your security you were signed out. Please sign in again.',
  FORBIDDEN: "You don't have permission to do that.",
  MFA_REQUIRED: 'Two-factor verification is required for this action.',
  ACCOUNT_BLOCKED: 'This account has been blocked. Contact support for help.',
  ACCOUNT_LOCKED: 'Too many failed attempts. The account is locked for a few minutes.',
  OTP_INVALID: "That code isn't right. Check the SMS and try again.",
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  OTP_ATTEMPTS_EXCEEDED: 'Too many wrong codes. Request a new code.',
  OTP_DELIVERY_FAILED: "We couldn't send the SMS right now. Please try again shortly.",
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  IDEMPOTENCY_IN_PROGRESS: 'Your previous attempt is still being processed. Please wait.',
  NOT_FOUND: "We couldn't find what you were looking for.",
};

/** Codes whose server message is technical; the friendly copy above is always better. */
const PREFER_FRIENDLY = new Set([
  'UNAUTHENTICATED', 'SESSION_REVOKED', 'SESSION_REUSE_DETECTED', 'MFA_REQUIRED', 'ACCOUNT_BLOCKED', 'ACCOUNT_LOCKED',
  'OTP_INVALID', 'OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED', 'OTP_DELIVERY_FAILED', 'INVALID_CREDENTIALS', 'RATE_LIMITED',
]);

/**
 * Best user-facing message for any thrown value: friendly copy for network/5xx and auth/OTP codes
 * (5xx messages are generic server-side anyway), otherwise the server's specific 4xx message.
 */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.status >= 500 || e.status === 0) return FRIENDLY[e.code] ?? FRIENDLY.INTERNAL_ERROR!;
    if (PREFER_FRIENDLY.has(e.code)) return FRIENDLY[e.code]!;
    return e.message || FRIENDLY[e.code] || 'Request failed.';
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

export interface ValidationIssue {
  path: string;
  code?: string;
  message: string;
}

/** `details.issues` from a VALIDATION_FAILED error (service-kit shape `[{ path, code, message }]`). */
export function validationIssues(e: unknown): ValidationIssue[] {
  if (!isApiError(e)) return [];
  const issues = (e.details as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (i): i is ValidationIssue => typeof i === 'object' && i !== null && typeof (i as ValidationIssue).message === 'string',
  ).map((i) => ({ ...i, path: String(i.path ?? '') }));
}

/**
 * Field errors keyed by field path with the `body.` / `query.` / `params.` prefix removed,
 * e.g. `{ phone: 'Invalid phone', 'address.pincode': 'Required' }`. First message per path wins.
 */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of validationIssues(e)) {
    const key = issue.path.replace(/^(body|query|params)\.?/, '') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export interface OtpErrorInfo {
  /** Seconds until another OTP may be requested (cooldown / rate limit). */
  retryAfterSec?: number;
  /** Verify attempts left for the current code, when the server reports it. */
  attemptsRemaining?: number;
}

/**
 * Extract cooldown and remaining attempts from an OTP request/verify error. Tolerant of naming:
 * `retryAfterSec` / `retryAfter` / `cooldownSec` and `attemptsRemaining` / `remainingAttempts` /
 * `attemptsLeft` in `details`, plus the `Retry-After` header.
 */
export function otpErrorInfo(e: unknown): OtpErrorInfo {
  if (!isApiError(e)) return {};
  const d = (e.details ?? {}) as Record<string, unknown>;
  const num = (...vals: unknown[]) => {
    for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
  };
  const info: OtpErrorInfo = {};
  const retry = num(e.retryAfterSec, d.retryAfterSec, d.retryAfter, d.cooldownSec);
  if (retry !== undefined) info.retryAfterSec = Math.max(0, Math.ceil(retry));
  const remaining = num(d.attemptsRemaining, d.remainingAttempts, d.attemptsLeft);
  if (remaining !== undefined) info.attemptsRemaining = Math.max(0, remaining);
  if (e.code === 'OTP_ATTEMPTS_EXCEEDED') info.attemptsRemaining = 0;
  return info;
}
