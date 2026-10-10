/**
 * Provider callbacks (🪝, no user auth — the signature is the credential):
 *  - POST /webhooks/twilio/status  X-Twilio-Signature over the configured callback URL + sorted form params
 *  - POST /webhooks/resend         Svix signature over the EXACT raw body, 5-minute timestamp tolerance
 * Verified callbacks are stored once (`provider_callbacks`, unique per event key) so replays are no-ops, and
 * statuses only move forward (never DELIVERED -> SENT).
 */
import express, { type Request, type Router } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '@thali/contracts';
import { twilioStatusCallbackUrl, type NotificationsConfig } from '../config.js';
import type { Dispatcher, ProviderStatus } from '../domain/dispatcher.js';
import type { ProviderCallbackModel } from '../models/provider-callback.js';
import { verifySvixSignature } from '../providers/resend-email.js';
import { validateTwilioSignature } from '../providers/twilio-sms.js';

const TWILIO_STATUS: Record<string, ProviderStatus | null> = {
  accepted: null,
  scheduled: null,
  queued: null,
  sending: null,
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'DELIVERED',
  undelivered: 'DEAD',
  failed: 'DEAD',
  canceled: 'DEAD',
};

const RESEND_STATUS: Record<string, ProviderStatus | null> = {
  'email.sent': 'SENT',
  'email.delivered': 'DELIVERED',
  'email.bounced': 'DEAD',
  'email.failed': 'DEAD',
  'email.suppressed': 'DEAD',
};

const invalidSignature = (status: number, message: string) => new DomainError('WEBHOOK_SIGNATURE_INVALID', message, status);

export interface WebhookDeps {
  config: NotificationsConfig;
  logger: Logger;
  dispatcher: Dispatcher;
  ProviderCallback: ProviderCallbackModel;
  now: () => Date;
}

function formParams(req: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  for (const [k, v] of new URLSearchParams(raw)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

export function webhooksRouter(deps: WebhookDeps): Router {
  const { config, logger, dispatcher, ProviderCallback, now } = deps;
  const r = express.Router();

  /** Store once; apply; mark applied. Returns false when the callback was already fully processed. */
  async function recordCallback(input: {
    provider: 'twilio' | 'resend';
    eventKey: string;
    providerMessageId: string;
    mappedStatus: ProviderStatus | null;
    error?: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const res = await ProviderCallback.updateOne(
      { provider: input.provider, eventKey: input.eventKey },
      {
        $setOnInsert: {
          providerMessageId: input.providerMessageId,
          mappedStatus: input.mappedStatus,
          error: input.error ?? null,
          payload: input.payload,
          receivedAt: now(),
          verified: true,
          applied: input.mappedStatus === null,
        },
      },
      { upsert: true },
    );
    if (!res.upsertedId) {
      const existing = await ProviderCallback.findOne({ provider: input.provider, eventKey: input.eventKey }, { applied: 1 }).lean();
      if (!existing || existing.applied) return; // replay
    }
    if (!input.mappedStatus) return;
    const outcome = await dispatcher.applyProviderStatus({ provider: input.provider, providerMessageId: input.providerMessageId, status: input.mappedStatus, error: input.error });
    if (outcome === 'not_found') {
      logger.info({ provider: input.provider }, 'status callback for an unknown message id; kept until the send is recorded');
      return;
    }
    await ProviderCallback.updateOne({ provider: input.provider, eventKey: input.eventKey }, { $set: { applied: true } });
  }

  r.post('/twilio/status', async (req, res) => {
    const token = config.TWILIO_AUTH_TOKEN;
    if (!token) throw new DomainError('NOT_FOUND', 'Not found');
    const url = twilioStatusCallbackUrl(config);
    if (!url) {
      logger.error('twilio status callback URL is not configured (TWILIO_STATUS_CALLBACK_URL / PUBLIC_API_URL); rejecting');
      throw invalidSignature(403, 'Invalid signature');
    }
    const params = formParams(req);
    const header = req.header('x-twilio-signature');
    if (!validateTwilioSignature(token, header, url, params)) {
      logger.warn({ hasSignature: Boolean(header) }, 'twilio webhook signature rejected');
      throw invalidSignature(403, 'Invalid signature');
    }
    const sid = typeof params.MessageSid === 'string' ? params.MessageSid : '';
    const status = typeof params.MessageStatus === 'string' ? params.MessageStatus.toLowerCase() : '';
    if (!sid || !status) throw new DomainError('VALIDATION_FAILED', 'MessageSid and MessageStatus are required');
    const errorCode = typeof params.ErrorCode === 'string' ? params.ErrorCode : undefined;
    const mapped = TWILIO_STATUS[status] ?? null;
    await recordCallback({
      provider: 'twilio',
      eventKey: `${sid}:${status}`,
      providerMessageId: sid,
      mappedStatus: mapped,
      error: mapped === 'DEAD' ? `twilio ${status}${errorCode ? `: error ${errorCode}` : ''}` : undefined,
      payload: { MessageSid: sid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}) },
    });
    res.status(204).end();
  });

  r.post('/resend', async (req, res) => {
    const secret = config.RESEND_WEBHOOK_SECRET;
    if (!secret) throw new DomainError('NOT_FOUND', 'Not found');
    const raw = req.rawBody;
    const ok =
      raw !== undefined &&
      verifySvixSignature({
        secret,
        id: req.header('svix-id'),
        timestamp: req.header('svix-timestamp'),
        signature: req.header('svix-signature'),
        body: raw,
      });
    if (!ok) {
      logger.warn('resend webhook signature rejected');
      throw invalidSignature(401, 'Invalid signature');
    }
    const body = req.body as { type?: unknown; data?: { email_id?: unknown } } | undefined;
    const type = typeof body?.type === 'string' ? body.type : '';
    const emailId = typeof body?.data?.email_id === 'string' ? body.data.email_id : '';
    if (!type) throw new DomainError('VALIDATION_FAILED', 'Webhook payload has no event type');
    const mapped = RESEND_STATUS[type];
    if (mapped !== undefined && emailId) {
      await recordCallback({
        provider: 'resend',
        eventKey: req.header('svix-id')!,
        providerMessageId: emailId,
        mappedStatus: mapped,
        error: mapped === 'DEAD' ? `resend ${type}` : undefined,
        payload: { type, data: { email_id: emailId } },
      });
    }
    res.json({ received: true });
  });

  return r;
}
