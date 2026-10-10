/**
 * Guest cart token (PRD C-6, LLD §10 orders): an opaque token issued by `POST /api/v1/cart/guest`
 * (`{ guestToken }`), kept in localStorage under `thali.guestCart`, and sent as `X-Guest-Cart` on cart
 * calls while signed out. `api(path, { guest: true })` does this automatically:
 *   - signed in            -> no guest header (bearer token wins)
 *   - signed out, GET      -> header only if a token already exists (never creates one just to read)
 *   - signed out, mutation -> creates the token first if needed (single-flight)
 * After OTP sign-in the AuthProvider merges the guest cart and clears the token.
 */
import { api } from './api';

export const GUEST_CART_STORAGE_KEY = 'thali.guestCart';
export const GUEST_CART_HEADER = 'X-Guest-Cart';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // private mode / disabled storage
  }
}

export function getGuestCartToken(): string | null {
  return storage()?.getItem(GUEST_CART_STORAGE_KEY) ?? null;
}

export function hasGuestCart(): boolean {
  return getGuestCartToken() !== null;
}

export function setGuestCartToken(token: string): void {
  storage()?.setItem(GUEST_CART_STORAGE_KEY, token);
}

export function clearGuestCartToken(): void {
  storage()?.removeItem(GUEST_CART_STORAGE_KEY);
}

let pending: Promise<string> | null = null;

/** Returns the stored guest token or creates one via `POST /cart/guest`. Concurrent callers share one request. */
export function ensureGuestCartToken(): Promise<string> {
  const existing = getGuestCartToken();
  if (existing) return Promise.resolve(existing);
  if (!pending) {
    pending = api<{ guestToken?: string; token?: string }>('/cart/guest', { method: 'POST', auth: false })
      .then((res) => {
        const token = res?.guestToken ?? res?.token;
        if (!token) throw new Error('Guest cart token missing from response');
        setGuestCartToken(token);
        return token;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}
