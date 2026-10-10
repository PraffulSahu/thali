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

/** `+919876543210` → `+91******3210`; other formats keep the first 3 and last 4 characters. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return phone.slice(0, 3) + '*'.repeat(phone.length - 7) + phone.slice(-4);
}
