/** 👤 customer tracking: order owner only (404 otherwise). */
import express, { type Router } from 'express';
import { requireAuth, validate } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { trackingFor } from '../domain/tracking.js';
import { ChildOrderParams } from '../schemas.js';

export function trackingRouter(ctx: DeliveryContext): Router {
  const r = express.Router();
  const v = validate({ params: ChildOrderParams });
  r.get('/tracking/:childOrderId', requireAuth(), v, async (req, res) => {
    res.json(await trackingFor(ctx, req.auth!.userId, v.get(req).params.childOrderId));
  });
  return r;
}
