/**
 * Internal service tokens (HLD 3.1): HS256 JWT, `iss=<caller>`, `aud=<callee>`, 60 s lifetime,
 * signed with `INTERNAL_SERVICE_SECRET`.
 */
import { randomUUID } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { DomainError, ServiceName } from '@thali/contracts';
import type { CallerContext } from '../types/express.js';

export const SERVICE_TOKEN_TTL_SEC = 60;
const encoder = new TextEncoder();
const SERVICE_NAMES = new Set<string>(Object.values(ServiceName));

/** Mint a token for `from` → `to`. */
export async function signServiceToken(
  from: ServiceName,
  to: ServiceName,
  secret: string,
  opts: { ttlSec?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(from)
    .setAudience(to)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSec ?? SERVICE_TOKEN_TTL_SEC))
    .setJti(randomUUID())
    .sign(encoder.encode(secret));
}

/** Verify a service token addressed to `audience` → `{ service }`, else DomainError(UNAUTHENTICATED). */
export async function verifyServiceToken(
  token: string,
  opts: { secret: string; audience: ServiceName },
): Promise<CallerContext> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(opts.secret), {
      algorithms: ['HS256'],
      audience: opts.audience,
      requiredClaims: ['iss', 'exp', 'iat'],
      // `exp` is checked strictly (no tolerance). No `maxTokenAge`: jose would then reject an `iat`
      // a fraction of a second in the future when the caller's clock runs slightly ahead.
    });
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > SERVICE_TOKEN_TTL_SEC) {
      throw new DomainError('UNAUTHENTICATED', 'Service token lifetime exceeds 60 s');
    }
    if (typeof payload.iss !== 'string' || !SERVICE_NAMES.has(payload.iss)) {
      throw new DomainError('UNAUTHENTICATED', 'Unknown calling service');
    }
    return { service: payload.iss as ServiceName };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    if (e instanceof joseErrors.JWTExpired) throw new DomainError('UNAUTHENTICATED', 'Service token expired');
    throw new DomainError('UNAUTHENTICATED', 'Invalid service token');
  }
}
