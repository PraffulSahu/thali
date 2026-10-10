/**
 * `requireAuth(opts?)` — verifies `Authorization: Bearer <access JWT>` with the app's AuthVerifier
 * (configured via `createApp({ auth })`, or built from `config.JWKS_URL` + `createApp({ redis })`),
 * sets `req.auth`, then enforces roles / MFA / admin sub-roles.
 *
 *  - no/invalid/expired token → 401 UNAUTHENTICATED; revoked session → 401 SESSION_REVOKED
 *  - `roles`: caller needs at least ONE of them → else 403 FORBIDDEN
 *  - `mfa: true`: `amr` must include `mfa` → else 403 MFA_REQUIRED
 *  - `adminRoles`: caller's `adm` must include one of them (SUPER_ADMIN always passes) → else 403
 *  - `optional: true`: no Authorization header → continue anonymously (`req.auth` undefined);
 *    a present-but-bad token is still 401.
 */
import type { Request, RequestHandler } from 'express';
import { DomainError, type AdminRole, type Role } from '@thali/contracts';
import { getKit } from '../context.js';
import type { AuthVerifier } from './jwks.js';

export interface RequireAuthOptions {
  roles?: Role[];
  mfa?: boolean;
  adminRoles?: AdminRole[];
  optional?: boolean;
  /** Use this verifier instead of the app's. */
  verifier?: AuthVerifier;
}

/** Extract a bearer token; `null` if no Authorization header; throws 401 if malformed. */
export function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new DomainError('UNAUTHENTICATED', 'Malformed Authorization header');
  return match[1]!;
}

export function requireAuth(opts: RequireAuthOptions = {}): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) {
      if (opts.optional) return next();
      throw new DomainError('UNAUTHENTICATED', 'Authentication required');
    }
    const verifier = opts.verifier ?? getKit(req).auth;
    if (!verifier) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'requireAuth: no AuthVerifier configured (pass createApp({ auth }) or config.JWKS_URL + redis)',
      );
    }
    const auth = await verifier.verify(token);
    req.auth = auth;

    if (opts.roles?.length && !opts.roles.some((r) => auth.roles.includes(r))) {
      throw new DomainError('FORBIDDEN', 'You do not have access to this resource');
    }
    if (opts.mfa && !auth.amr.includes('mfa')) {
      throw new DomainError('MFA_REQUIRED', 'Multi-factor authentication required');
    }
    if (
      opts.adminRoles?.length &&
      !auth.adminRoles.includes('SUPER_ADMIN') &&
      !opts.adminRoles.some((r) => auth.adminRoles.includes(r))
    ) {
      throw new DomainError('FORBIDDEN', 'Your admin role does not allow this action');
    }
    next();
  };
}
