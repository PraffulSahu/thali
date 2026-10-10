/**
 * Pickup / delivery handover codes. `order.accepted` carries the plain codes; delivery stores only
 * sha256 hashes (scoped to the child order so equal codes on different orders hash differently)
 * and compares in constant time.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function hashCode(childOrderId: string, code: string): string {
  return createHash('sha256').update(`thali-handover:${childOrderId}:${code}`).digest('hex');
}

export function verifyCode(childOrderId: string, code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCode(childOrderId, code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
