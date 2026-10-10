/**
 * Local contract additions (Phase 1 rule: never edit packages/*). Reconciled by the controller.
 *
 * - `PARTNER_PROFILE_INCOMPLETE` (422): partner submit without required profile fields/documents.
 *   `@thali/contracts` has no generic 422 business code that fits; `details.missing` lists what is missing.
 * - `PARTNER_HAS_ACTIVE_JOBS` (409): partner tries to go offline while holding active deliveries.
 */
import { DomainError, type ErrorCode } from '@thali/contracts';

export const LOCAL_ERROR_STATUS = {
  PARTNER_PROFILE_INCOMPLETE: 422,
  PARTNER_HAS_ACTIVE_JOBS: 409,
} as const;

export type LocalErrorCode = keyof typeof LOCAL_ERROR_STATUS;

export function localError(code: LocalErrorCode, message: string, details?: unknown): DomainError {
  return new DomainError(code as unknown as ErrorCode, message, LOCAL_ERROR_STATUS[code], details);
}
