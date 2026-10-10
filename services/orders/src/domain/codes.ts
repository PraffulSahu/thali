/**
 * Human order codes (`TH-` + 8 Crockford base32 chars, LLD §1.1) and 4-digit handover codes
 * (pickup / delivery), all from `crypto` randomness.
 */
import { randomInt } from 'node:crypto';
import { DomainError } from '@thali/contracts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function orderCode(): string {
  let s = 'TH-';
  for (let i = 0; i < 8; i++) s += CROCKFORD[randomInt(0, 32)];
  return s;
}

export function handoverCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** Pickup and delivery codes for one child; never equal so one cannot stand in for the other. */
export function handoverCodePair(): { pickupCode: string; deliveryCode: string } {
  const pickupCode = handoverCode();
  let deliveryCode = handoverCode();
  while (deliveryCode === pickupCode) deliveryCode = handoverCode();
  return { pickupCode, deliveryCode };
}

/**
 * Last 4 digits of a phone (or of its masked snapshot `+91******3210`) for indexed admin phone
 * search (ORD-7); null when fewer than 4 digits are known.
 */
export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = digitsOf(phone);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Only the digits of a phone-like string. */
export function digitsOf(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Escape a user string for use inside a Mongo `$regex`. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A search term that is a phone (4–13 digits, optionally with +, spaces, dashes, brackets) → its last
 * 4 digits (ORD-7), else null. A digit-only term is therefore never a name search.
 */
export function phoneTermLast4(term: string): string | null {
  if (!/^\+?[\d\s()-]+$/.test(term)) return null;
  const digits = digitsOf(term);
  return digits.length >= 4 && digits.length <= 13 ? digits.slice(-4) : null;
}

/** `phone` query param → last 4 digits (only a masked snapshot is stored); fewer than 4 digits → 400. */
export function phoneParamLast4(phone: string): string {
  const digits = digitsOf(phone);
  if (digits.length < 4) {
    throw new DomainError('VALIDATION_FAILED', 'Enter at least the last 4 digits of the phone number', 400, {
      issues: [{ path: 'query.phone', code: 'too_small', message: 'At least 4 digits' }],
    });
  }
  return digits.slice(-4);
}

/** Customer contact snapshot stored on child orders and checkout groups (name + masked phone + last 4 digits). */
export function customerContactOf(user: { name?: string | null; phone?: string | null } | null | undefined): {
  name: string;
  phoneMasked: string;
  phoneLast4: string | null;
} {
  return { name: user?.name ?? 'Customer', phoneMasked: maskPhone(user?.phone), phoneLast4: phoneLast4(user?.phone) };
}

/** `+919876543210` → `+91******3210`; other formats keep the first 3 and last 4 characters. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return phone.slice(0, 3) + '*'.repeat(phone.length - 7) + phone.slice(-4);
}
