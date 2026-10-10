/**
 * `requireInternal(allowed?)` — accepts only service tokens addressed to this service
 * (`aud = config.SERVICE_NAME`, secret `config.INTERNAL_SERVICE_SECRET`) and sets `req.caller`.
 * Missing/invalid/expired/wrong-audience → 401 UNAUTHENTICATED; caller not in `allowed` → 403 FORBIDDEN.
 * User access tokens are always rejected (different algorithm and key).
 */
import type { RequestHandler } from 'express';
import { DomainError, type ServiceName } from '@thali/contracts';
import { getKit } from '../context.js';
import { bearerToken } from './require-auth.js';
import { verifyServiceToken } from './service-token.js';

export function requireInternal(allowed?: ServiceName[]): RequestHandler {
  return async (req, _res, next) => {
    const { config } = getKit(req);
    const token = bearerToken(req);
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Service token required');
    const caller = await verifyServiceToken(token, {
      secret: config.INTERNAL_SERVICE_SECRET,
      audience: config.SERVICE_NAME,
    });
    if (allowed?.length && !allowed.includes(caller.service)) {
      throw new DomainError('FORBIDDEN', `Service ${caller.service} may not call this route`);
    }
    req.caller = caller;
    next();
  };
}
