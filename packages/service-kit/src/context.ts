/**
 * Per-app kit context stored on `app.locals.kit` by `createApp`, so middleware with LLD-exact
 * signatures (`requireAuth(opts)`, `requireInternal(allowed)`) can reach config / verifier.
 */
import type { Request } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '@thali/contracts';
import type { AuthVerifier } from './auth/jwks.js';
import type { BaseConfig } from './config.js';
import type { Redis } from './redis.js';

export interface KitContext {
  config: BaseConfig;
  logger: Logger;
  auth?: AuthVerifier;
  redis?: Redis;
}

export function getKit(req: Request): KitContext {
  const kit = (req.app?.locals as { kit?: KitContext } | undefined)?.kit;
  if (!kit) {
    throw new DomainError('INTERNAL_ERROR', 'service-kit middleware used outside an app built by createApp');
  }
  return kit;
}
