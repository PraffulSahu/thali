/**
 * Human order codes (`TH-` + 8 Crockford base32 chars, LLD §1.1) and 4-digit handover codes
 * (pickup / delivery), all from `crypto` randomness.
 */
import { randomInt } from 'node:crypto';

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
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
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
