import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/mobile';
import { DomainError } from './errors.js';

/**
 * Normalize a phone number to E.164. Accepts `+91 98765 43210`, `09876543210`, `9876543210`,
 * `919876543210` (default region IN). Throws `DomainError(VALIDATION_FAILED)` for invalid,
 * extension-bearing or non-mobile numbers (landlines are rejected).
 */
export function normalizePhone(input: string, defaultRegion: string = 'IN'): string {
  const fail = (reason: string): never => {
    throw new DomainError('VALIDATION_FAILED', 'Enter a valid mobile number', undefined, { field: 'phone', reason });
  };
  if (typeof input !== 'string' || input.trim() === '') return fail('empty');
  const parsed = parsePhoneNumberFromString(input.trim(), defaultRegion as CountryCode);
  if (!parsed) return fail('unparseable');
  if (parsed.ext) return fail('extension');
  if (!parsed.isValid()) return fail('invalid');
  const type = parsed.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return fail('not_mobile');
  return parsed.number;
}

/** Non-throwing variant. */
export function tryNormalizePhone(input: string, defaultRegion: string = 'IN'): string | null {
  try {
    return normalizePhone(input, defaultRegion);
  } catch {
    return null;
  }
}
