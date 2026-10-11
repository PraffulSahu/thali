/** Internal API (binding shapes in docs/03-LLD.md). Callers: orders, marketplace. */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { requireInternal, validate } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { createIntent, findIntentByReference, intentView } from '../domain/intents.js';
import { reconcileIntent } from '../domain/reconcile.js';
import { ByReferenceParams, IntentCreateBody, IntentIdParams } from '../schemas.js';

export const INTERNAL_CALLERS = ['orders', 'marketplace'] as const;

export function internalRouter(ctx: PaymentsContext): Router {
  const r = express.Router();
  const guard = requireInternal([...INTERNAL_CALLERS]);

  const vCreate = validate({ body: IntentCreateBody });
  r.post('/internal/payment-intents', guard, vCreate, async (req, res) => {
    const { body } = vCreate.get(req);
    const { intent, created } = await createIntent(ctx, body);
    res.status(created ? 201 : 200).json(intentView(ctx, intent));
  });

  const vId = validate({ params: IntentIdParams });
  r.post('/internal/payment-intents/:id/reconcile', guard, vId, async (req, res) => {
    const { params } = vId.get(req);
    res.json(await reconcileIntent(ctx, params.id));
  });

  const vRef = validate({ params: ByReferenceParams });
  r.get('/internal/payment-intents/by-reference/:purpose/:refId', guard, vRef, async (req, res) => {
    const { params } = vRef.get(req);
    const intent = await findIntentByReference(ctx, params.purpose, params.refId);
    if (!intent || !intent.providerOrderId) throw new DomainError('NOT_FOUND', 'Payment intent not found');
    res.json(intentView(ctx, intent));
  });
  return r;
}
