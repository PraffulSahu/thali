/**
 * Access-token verification (HLD 5, LLD 5): EdDSA/Ed25519 JWTs from identity, verified against a
 * JWKS (remote URL with jose's cache, or an injected local key set) plus the Redis revocation key
 * `<REDIS_KEY_PREFIX>revoked:sid:<sid>`.
 */
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { AdminRole, DomainError, enumValues, Role } from '@thali/contracts';
import type { AuthContext } from '../types/express.js';
import { redisKey, type Redis } from '../redis.js';

/** `iss` of access tokens minted by identity. */
export const ACCESS_TOKEN_ISSUER = 'thali-identity';
/** `aud` of access tokens minted by identity. */
export const ACCESS_TOKEN_AUDIENCE = 'thali';
/** Accepted JWS algorithms for access tokens. */
export const ACCESS_TOKEN_ALGORITHMS = ['EdDSA', 'Ed25519'];
/** Allowed clock skew between services when checking exp/iat/nbf. */
export const CLOCK_TOLERANCE_SEC = 5;
/** Revocation key TTL = access token lifetime (15 min). */
export const REVOCATION_TTL_SEC = 15 * 60;

/** Unprefixed revocation key name. */
export const revocationKeyName = (sid: string) => `revoked:sid:${sid}`;

/** Mark a session revoked for `ttlSec` (identity calls this on logout / family revoke). */
export async function revokeSession(
  redis: Redis,
  sid: string,
  opts: { ttlSec?: number; keyPrefix?: string } = {},
): Promise<void> {
  await redis.set(redisKey(redis, revocationKeyName(sid), opts.keyPrefix), '1', 'EX', opts.ttlSec ?? REVOCATION_TTL_SEC);
}

export interface AuthVerifierOptions {
  /** Inject a key set directly (tests, or identity verifying its own tokens). */
  jwks?: JSONWebKeySet;
  /** Remote JWKS URL (usually `config.JWKS_URL`); cached by jose. */
  jwksUrl?: string;
  /** Redis used for the revocation check (required: revocation is never skipped). */
  redis: Redis;
  /** Overrides the client's registered key prefix. */
  keyPrefix?: string;
  issuer?: string;
  audience?: string;
}

export interface AuthVerifier {
  /** Verify a bearer token → AuthContext, or throw DomainError(UNAUTHENTICATED | SESSION_REVOKED | SERVICE_UNAVAILABLE). */
  verify(token: string): Promise<AuthContext>;
}

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  roles: z.array(z.enum(enumValues(Role))),
  amr: z.array(z.string()).default([]),
  adm: z.array(z.enum(enumValues(AdminRole))).default([]),
});

const unauthenticated = (message: string) => new DomainError('UNAUTHENTICATED', message);

export function createAuthVerifier(opts: AuthVerifierOptions): AuthVerifier {
  let keySet: JWTVerifyGetKey;
  if (opts.jwks) keySet = createLocalJWKSet(opts.jwks);
  else if (opts.jwksUrl) keySet = createRemoteJWKSet(new URL(opts.jwksUrl), { timeoutDuration: 3000 });
  else throw new Error('createAuthVerifier: provide `jwks` or `jwksUrl`');
  const issuer = opts.issuer ?? ACCESS_TOKEN_ISSUER;
  const audience = opts.audience ?? ACCESS_TOKEN_AUDIENCE;

  return {
    async verify(token) {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, keySet, {
          algorithms: ACCESS_TOKEN_ALGORITHMS,
          issuer,
          audience,
          clockTolerance: CLOCK_TOLERANCE_SEC,
        }));
      } catch (e) {
        if (e instanceof joseErrors.JWTExpired) throw unauthenticated('Access token expired');
        if (e instanceof joseErrors.JWKSTimeout || !(e instanceof joseErrors.JOSEError)) {
          throw new DomainError('SERVICE_UNAVAILABLE', 'Unable to verify access token right now');
        }
        throw unauthenticated('Invalid access token');
      }
      const claims = ClaimsSchema.safeParse(payload);
      if (!claims.success) throw unauthenticated('Invalid access token claims');
      const { sub, sid, roles, amr, adm } = claims.data;

      let revoked: number;
      try {
        revoked = await opts.redis.exists(redisKey(opts.redis, revocationKeyName(sid), opts.keyPrefix));
      } catch {
        throw new DomainError('SERVICE_UNAVAILABLE', 'Unable to verify session right now');
      }
      if (revoked) throw new DomainError('SESSION_REVOKED', 'Session has been revoked');

      return { userId: sub, roles, sessionId: sid, amr, adminRoles: adm };
    },
  };
}
