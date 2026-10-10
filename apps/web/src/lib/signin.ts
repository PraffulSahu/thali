/**
 * Unified sign-in helpers (board 01): role tab parsing, safe `next` handling and where to land after sign-in.
 *
 *   const role = parseSignInRole(params.get('role'));                     // customer | restaurant | partner | admin
 *   navigate(destinationAfterSignIn(role, rolesFromSignIn(user, getAccessToken()), params.get('next')));
 */
import type { Role } from '@thali/contracts';
import type { AuthUser } from './auth';
import { decodeJwt } from './jwt';

export type SignInRole = 'customer' | 'restaurant' | 'partner' | 'admin';
export const SIGN_IN_ROLES: SignInRole[] = ['customer', 'restaurant', 'partner', 'admin'];

export function parseSignInRole(raw: string | null | undefined): SignInRole {
  return SIGN_IN_ROLES.includes(raw as SignInRole) ? (raw as SignInRole) : 'customer';
}

/** Only same-origin relative paths (no open redirects). */
export function safeRelative(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`);

export function rolesFromSignIn(user: AuthUser | null | undefined, token: string | null | undefined): Role[] {
  const claims = decodeJwt(token);
  return claims?.roles ?? user?.roles ?? [];
}

/** Landing route after a successful sign-in for the chosen role tab. */
export function destinationAfterSignIn(role: SignInRole, roles: Role[], rawNext: string | null | undefined): string {
  const next = safeRelative(rawNext);
  if (role === 'admin') {
    if (next && within(next, '/admin') && !within(next, '/admin/login') && !within(next, '/admin/forgot') && !within(next, '/admin/reset-password')) return next;
    return '/admin';
  }
  if (role === 'restaurant' || role === 'partner') {
    const base = role === 'restaurant' ? '/restaurant' : '/partner';
    const onboarding = `${base}/onboarding`;
    const has = roles.includes(role === 'restaurant' ? 'RESTAURANT_OWNER' : 'DELIVERY_PARTNER');
    if (!has) return next && within(next, onboarding) ? next : onboarding;
    return next ?? base;
  }
  return next ?? '/';
}
