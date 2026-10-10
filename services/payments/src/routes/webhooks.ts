/**
 * 🪝 POST /api/v1/webhooks/razorpay — mounted with `express.raw` BEFORE any JSON parser (app.ts disables
 * the kit's global parser) so the signature is checked over the exact bytes received.
 */
import express, { type Router } from 'express';
import type { PaymentsContext } from '../context.js';
import { ingestWebhook } from '../domain/webhook.js';

export const WEBHOOK_PATH = '/api/v1/webhooks/razorpay';

export function webhookRouter(ctx: PaymentsContext): Router {
  const r = express.Router();
  r.post(WEBHOOK_PATH, express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await ingestWebhook(ctx, {
      rawBody,
      signature: req.header('x-razorpay-signature') ?? undefined,
      eventId: req.header('x-razorpay-event-id') ?? undefined,
      mockHeader: req.header('x-thali-mock') !== undefined,
    });
    res.status(200).json({ status: 'ok', eventId: out.eventId, result: out.result });
  });
  return r;
}
