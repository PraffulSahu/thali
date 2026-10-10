/**
 * Event consumers (LLD §9). Handlers run inside the consumer's per-event Mongo transaction and make NO network
 * calls: they only insert notification rows through the dispatcher, whose unique `dedupeKey` makes redelivery
 * harmless. Recipient lookup (identity / orders), preferences and sending happen at dispatch time, after commit,
 * in the worker (retry/backoff applies there).
 *
 * Consumed: restaurant.submitted, restaurant.email_verification_requested, restaurant.status_changed,
 * membership.activated, order.placed/accepted/rejected/cancelled/out_for_delivery/delivered/delivery_failed,
 * refund.succeeded, delivery.exception, partner.status_changed.
 * Deliberately not notified (no template / no recipient in payload): user.registered, order.preparing/ready/
 * picked_up, delivery.* lifecycle, refund.requested/processing/failed.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { EventEnvelope, EventType } from '@thali/contracts';
import type { ClientSession, EventHandlers } from '@thali/service-kit';
import type { Dispatcher } from '../domain/dispatcher.js';
import { templateDef, type TemplateData, type TemplateName } from '../domain/templates.js';

export interface HandlerDeps {
  dispatcher: Dispatcher;
  logger: Pick<Logger, 'info' | 'warn'>;
}

type Env<T extends EventType> = EventEnvelope<T>;

export function createEventHandlers(deps: HandlerDeps): EventHandlers {
  const { dispatcher, logger } = deps;

  /**
   * Handlers never call identity/orders: they only insert notification rows (inside the consumer's transaction).
   * One row per channel the template supports; the dispatch worker resolves the recipient's phone/email and
   * preferences outside any transaction and marks rows SKIPPED (opted out / blocked / no address) or retries
   * them with backoff when identity is unavailable. dedupeKey: `<eventId>:<template>:<channel>:<recipient>`.
   */
  async function enqueueFor(
    env: EventEnvelope,
    recipient: { userId?: string; childOrderId?: string },
    template: TemplateName,
    data: TemplateData,
    session: ClientSession,
  ) {
    const ref = recipient.userId ?? (recipient.childOrderId ? `order:${recipient.childOrderId}` : undefined);
    if (!ref) {
      logger.warn({ eventId: env.id, type: env.type }, 'event has no resolvable recipient; skipping');
      return;
    }
    const ids: string[] = [];
    for (const channel of templateDef(template).channels) {
      const r = await dispatcher.enqueue(
        {
          channel,
          template,
          data,
          dedupeKey: `${env.id}:${template}:${channel}:${ref}`,
          ...(recipient.userId ? { userId: recipient.userId } : { recipientChildOrderId: recipient.childOrderId }),
          sourceEventId: env.id,
        },
        { session },
      );
      if (r.created) ids.push(r.id);
    }
    dispatcher.kick(ids);
  }

  const notifyUser = (env: EventEnvelope, userId: string | undefined, template: TemplateName, data: TemplateData, session: ClientSession) =>
    enqueueFor(env, { userId }, template, data, session);

  async function notifyAdmins(env: EventEnvelope, template: TemplateName, data: TemplateData, session: ClientSession) {
    const r = await dispatcher.enqueue(
      { channel: 'IN_APP', audience: 'ADMIN', template, data, dedupeKey: `${env.id}:${template}:IN_APP:admin`, sourceEventId: env.id },
      { session },
    );
    if (r.created) dispatcher.kick([r.id]);
  }

  const h: EventHandlers = {
    'restaurant.submitted': async (e: Env<'restaurant.submitted'>, s) => {
      await notifyAdmins(e, 'restaurant_submitted_admin', { restaurantId: e.payload.restaurantId }, s);
    },

    // The verification URL carries a raw token: it goes to the provider only (stored encrypted, never logged).
    'restaurant.email_verification_requested': async (e: Env<'restaurant.email_verification_requested'>, s) => {
      const to = e.payload.email.trim().toLowerCase();
      const hash = createHash('sha256').update(to).digest('hex').slice(0, 16);
      const r = await dispatcher.enqueue(
        { channel: 'EMAIL', template: 'restaurant_email_verification', to, data: { verifyUrl: e.payload.verifyUrl }, dedupeKey: `${e.id}:restaurant_email_verification:EMAIL:h:${hash}`, sourceEventId: e.id },
        { session: s },
      );
      if (r.created) dispatcher.kick([r.id]);
    },

    'restaurant.status_changed': async (e: Env<'restaurant.status_changed'>, s) => {
      const { ownerUserId, name, from, to, reason } = e.payload;
      await notifyUser(e, ownerUserId, 'restaurant_status_changed', { name, from, to, ...(reason ? { reason } : {}) }, s);
    },

    'membership.activated': async (e: Env<'membership.activated'>, s) => {
      await notifyUser(e, e.payload.userId, 'membership_activated', { endsAt: e.payload.endsAt }, s);
    },

    'order.placed': async (e: Env<'order.placed'>, s) => {
      const p = e.payload;
      await notifyUser(e, p.userId, 'order_placed_customer', { code: p.code, totalPaise: p.totalPaise, checkoutId: p.checkoutId, childOrderId: p.childOrderId }, s);
      await notifyUser(e, p.restaurantOwnerId, 'order_placed_restaurant', { code: p.code, totalPaise: p.totalPaise, acceptBy: p.acceptBy, childOrderId: p.childOrderId, restaurantId: p.restaurantId }, s);
    },

    // Customer notifications carry checkoutId/childOrderId (non-secret) so the web inbox can deep-link to the order.
    // Pickup/delivery codes are deliberately NOT forwarded: they stay inside orders/delivery.
    'order.accepted': async (e: Env<'order.accepted'>, s) => {
      const { prepMinutes, checkoutId, childOrderId } = e.payload;
      await notifyUser(e, e.payload.userId, 'order_accepted', { prepMinutes, checkoutId, childOrderId }, s);
    },

    'order.rejected': async (e: Env<'order.rejected'>, s) => {
      const { reason, refundPaise, checkoutId, childOrderId } = e.payload;
      await notifyUser(e, e.payload.userId, 'order_rejected', { reason, refundPaise, checkoutId, childOrderId }, s);
    },

    'order.cancelled': async (e: Env<'order.cancelled'>, s) => {
      const { reason, refundPaise, actor, checkoutId, childOrderId } = e.payload;
      await notifyUser(e, e.payload.userId, 'order_cancelled', { reason, refundPaise, actor, checkoutId, childOrderId }, s);
    },

    'order.out_for_delivery': async (e: Env<'order.out_for_delivery'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_out_for_delivery', { childOrderId: e.payload.childOrderId }, s);
    },

    'order.delivered': async (e: Env<'order.delivered'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_delivered', { checkoutId: e.payload.checkoutId, childOrderId: e.payload.childOrderId }, s);
    },

    'order.delivery_failed': async (e: Env<'order.delivery_failed'>, s) => {
      await notifyAdmins(e, 'delivery_exception_admin', { childOrderId: e.payload.childOrderId, reason: e.payload.reason }, s);
    },

    'delivery.exception': async (e: Env<'delivery.exception'>, s) => {
      const { jobId, childOrderId, reason } = e.payload;
      await notifyAdmins(e, 'delivery_exception_admin', { jobId, childOrderId, reason }, s);
    },

    // The refund payload has no user id: the user is resolved from the child order at dispatch time. Checkout-level
    // refunds without a child order cannot be attributed and are skipped (see report "Contract gaps").
    'refund.succeeded': async (e: Env<'refund.succeeded'>, s) => {
      const { childOrderId, amountPaise, refundId, checkoutGroupId } = e.payload;
      if (!childOrderId) {
        logger.info({ eventId: e.id, refundId }, 'refund has no child order; cannot resolve recipient; skipping');
        return;
      }
      await enqueueFor(e, { childOrderId }, 'refund_succeeded', { amountPaise, checkoutId: checkoutGroupId, childOrderId }, s);
    },

    'partner.status_changed': async (e: Env<'partner.status_changed'>, s) => {
      const { userId, from, to, reason } = e.payload;
      await notifyUser(e, userId, 'partner_status_changed', { from, to, ...(reason ? { reason } : {}) }, s);
    },
  };
  return h;
}
