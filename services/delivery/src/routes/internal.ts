/** Internal ops routes (service token): health details + dead letters (service-kit ops router). */
import type { Router } from 'express';
import { createOpsRouter } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { CONSUMED_STREAMS } from '../events/handlers.js';

export function internalRouter(ctx: DeliveryContext): Router {
  return createOpsRouter({ conn: ctx.conn, redis: ctx.redis, config: ctx.config, streams: CONSUMED_STREAMS });
}
