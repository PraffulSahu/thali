/**
 * Read (NOT verify) access-token claims for UI decisions: roles, admin roles, amr, expiry.
 * The server verifies every request; the client only uses claims to choose what to render.
 * Claims per identity service: `{ sub, roles, adm?, sid, amr, exp, iss, aud }`.
 */
import type { AdminRole, Role } from '@thali/contracts';

export interface AccessClaims {
  sub?: string;
  roles?: Role[];
  adm?: AdminRole[];
  sid?: string;
  amr?: string[];
  exp?: number;
  [claim: string]: unknown;
}

export function decodeJwt(token: string | null | undefined): AccessClaims | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = decodeURIComponent(
      Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === 'object' ? (claims as AccessClaims) : null;
  } catch {
    return null;
  }
}
