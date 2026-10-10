/** Guest cart tokens: 32 random bytes base64url (43 chars); only the sha256 hex is stored. */
import { createHash, randomBytes } from 'node:crypto';

export const GUEST_CART_HEADER = 'x-guest-cart';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedGuestToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}
