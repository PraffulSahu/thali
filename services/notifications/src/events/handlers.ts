/**
 * Event consumers (LLD §9). Handlers run inside the consumer's per-event Mongo transaction: they only look up
 * recipients (idempotent GETs) and insert notification records through the dispatcher, whose unique
 * `dedupeKey` (`<eventId>:<channel>:<recipient>`) makes redelivery harmless. Sending happens after commit
 * (dispatcher kick + poller), never inside the transaction.
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
import type { RecipientDirectory } from '../domain/recipients.js';
import { planChannels } from '../domain/recipients.js';
import type { TemplateData, TemplateName } from '../domain/templates.js';

/** orders `GET /internal/orders/child/:id` (binding shape): only what we need. */
export interface OrdersLookup {
  getChildOrder(childOrderId: string): Promise<{ id: string; userId: string } | null>;
}

export interface HandlerDeps {
  dispatcher: Dispatcher;
  directory: RecipientDirectory;
  orders: OrdersLookup;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

type Env<T extends EventType> = EventEnvelope<T>;

export function createEventHandlers(deps: HandlerDeps): EventHandlers {
  const { dispatcher, directory, logger } = deps;

  interface Target {
    userId: string | undefined;
    template: TemplateName;
    data: TemplateData;
  }

  /**
   * In-app + allowed SMS/email for each target user. All recipient lookups happen before the first write so the
   * (consumer-owned) transaction is not held open across several HTTP calls. Unknown user: logged and skipped.
   */
  async function notifyUsers(env: EventEnvelope, targets: Target[], session: ClientSession) {
    const users = await Promise.all(
      targets.map(async (t) => {
        if (!t.userId) {
          logger.warn({ eventId: env.id, type: env.type }, 'event has no recipient user id; skipping');
          return null;
        }
        const user = await directory.getUser(t.userId);
        if (!user) logger.info({ eventId: env.id, type: env.type, userId: t.userId }, 'recipient user not found; skipping');
        return user;
      }),
    );
    const ids: string[] = [];
    for (const [i, t] of targets.entries()) {
      const user = users[i];
      if (!user) continue;
      for (const channel of planChannels(t.template, user)) {
        const r = await dispatcher.enqueue(
          {
            channel,
            template: t.template,
            data: t.data,
            dedupeKey: `${env.id}:${channel}:${t.userId}`,
            userId: t.userId,
            to: channel === 'SMS' ? user.phone! : channel === 'EMAIL' ? user.email! : undefined,
            sourceEventId: env.id,
          },
          { session },
        );
        if (r.created) ids.push(r.id);
      }
    }
    dispatcher.kick(ids);
  }

  const notifyUser = (env: EventEnvelope, userId: string | undefined, template: TemplateName, data: TemplateData, session: ClientSession) =>
    notifyUsers(env, [{ userId, template, data }], session);

  async function notifyAdmins(env: EventEnvelope, template: TemplateName, data: TemplateData, session: ClientSession) {
    const r = await dispatcher.enqueue(
      { channel: 'IN_APP', audience: 'ADMIN', template, data, dedupeKey: `${env.id}:IN_APP:admin`, sourceEventId: env.id },
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
        { channel: 'EMAIL', template: 'restaurant_email_verification', to, data: { verifyUrl: e.payload.verifyUrl }, dedupeKey: `${e.id}:EMAIL:h:${hash}`, sourceEventId: e.id },
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
      await notifyUsers(
        e,
        [
          { userId: p.userId, template: 'order_placed_customer', data: { code: p.code, totalPaise: p.totalPaise } },
          { userId: p.restaurantOwnerId, template: 'order_placed_restaurant', data: { code: p.code, totalPaise: p.totalPaise, acceptBy: p.acceptBy } },
        ],
        s,
      );
    },

    // Pickup/delivery codes are deliberately NOT forwarded: they stay inside orders/delivery.
    'order.accepted': async (e: Env<'order.accepted'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_accepted', { prepMinutes: e.payload.prepMinutes }, s);
    },

    'order.rejected': async (e: Env<'order.rejected'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_rejected', { reason: e.payload.reason, refundPaise: e.payload.refundPaise }, s);
    },

    'order.cancelled': async (e: Env<'order.cancelled'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_cancelled', { reason: e.payload.reason, refundPaise: e.payload.refundPaise, actor: e.payload.actor }, s);
    },

    'order.out_for_delivery': async (e: Env<'order.out_for_delivery'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_out_for_delivery', {}, s);
    },

    'order.delivered': async (e: Env<'order.delivered'>, s) => {
      await notifyUser(e, e.payload.userId, 'order_delivered', {}, s);
    },

    'order.delivery_failed': async (e: Env<'order.delivery_failed'>, s) => {
      await notifyAdmins(e, 'delivery_exception_admin', { childOrderId: e.payload.childOrderId, reason: e.payload.reason }, s);
    },

    'delivery.exception': async (e: Env<'delivery.exception'>, s) => {
      const { jobId, childOrderId, reason } = e.payload;
      await notifyAdmins(e, 'delivery_exception_admin', { jobId, childOrderId, reason }, s);
    },

    // refund payload has no user id: resolve through the order (checkout-level refunds without a child order
    // cannot be attributed to a user and are skipped; see report "Contract gaps").
    'refund.succeeded': async (e: Env<'refund.succeeded'>, s) => {
      const { childOrderId, amountPaise, refundId } = e.payload;
      if (!childOrderId) {
        logger.info({ eventId: e.id, refundId }, 'refund has no child order; cannot resolve recipient; skipping');
        return;
      }
      const order = await deps.orders.getChildOrder(childOrderId);
      if (!order) {
        logger.info({ eventId: e.id, childOrderId }, 'child order not found; skipping refund notification');
        return;
      }
      await notifyUser(e, order.userId, 'refund_succeeded', { amountPaise }, s);
    },

    'partner.status_changed': async (e: Env<'partner.status_changed'>, s) => {
      const { userId, from, to, reason } = e.payload;
      await notifyUser(e, userId, 'partner_status_changed', { from, to, ...(reason ? { reason } : {}) }, s);
    },
  };
  return h;
}
