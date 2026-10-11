/**
 * Notifications demo seed (APP_MODE=demo only; idempotent; writes only thali_notifications).
 *
 *   container:  docker compose exec notifications node dist/seed.js
 *   local:      npm run seed -w @thali/notifications
 *
 * In-app inbox history that matches the other seeds' story (restaurant approvals, partner approvals and a
 * suspension). Rendered with the real templates and stored as already SENT, so the worker never re-sends
 * them. Ids: `notification:<key>`; dedupe keys `seed:<key>`. Order notifications follow the shared demo order history
 * (`@thali/contracts/seed-demo`) and carry checkoutId/childOrderId so the web inbox deep-links to the order.
 *
 * The CLI then adds the Bengaluru dataset's inbox (`./seed-blr.ts`; skip with SEED_BLR=0).
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { DEMO_CHECKOUTS, demoOrderIds as ids, demoRefundPaise, demoTimeline } from '@thali/contracts/seed-demo';
import { buildBlrWorld, loadPricing } from '@thali/contracts/seed-blr';
import { initEventCollections } from '@thali/service-kit';
import { ensureDocs, isMainModule, runSeedCli, type SeedReport } from '@thali/service-kit/seed';
import { renderTemplate, type TemplateName } from './domain/templates.js';
import { notificationModel } from './models/notification.js';
import { providerCallbackModel } from './models/provider-callback.js';
import { seedNotificationsBlr } from './seed-blr.js';

interface InAppSpec {
  key: string;
  user: string;
  template: TemplateName;
  data: Record<string, unknown>;
  at: string;
  read?: boolean;
}

const IN_APP: InAppSpec[] = [
  {
    key: 'owner1:spice-route-approved', user: 'owner1', template: 'restaurant_status_changed', at: '2026-09-01T06:30:00.000Z', read: true,
    data: { restaurantId: seedId('restaurant:spice-route'), name: 'Spice Route', from: 'APPROVAL_PENDING', to: 'APPROVED' },
  },
  {
    key: 'owner1:tandoor-tales-submitted', user: 'owner1', template: 'restaurant_status_changed', at: '2026-09-01T05:30:00.000Z',
    data: { restaurantId: seedId('restaurant:tandoor-tales'), name: 'Tandoor Tales', from: 'VERIFICATION_PENDING', to: 'APPROVAL_PENDING' },
  },
  {
    key: 'owner2:green-leaf-approved', user: 'owner2', template: 'restaurant_status_changed', at: '2026-09-01T06:30:00.000Z',
    data: { restaurantId: seedId('restaurant:green-leaf'), name: 'Green Leaf', from: 'APPROVAL_PENDING', to: 'APPROVED' },
  },
  { key: 'partner1:approved', user: 'partner1', template: 'partner_status_changed', at: '2026-09-01T06:00:00.000Z', read: true, data: { from: 'APPROVAL_PENDING', to: 'APPROVED' } },
  { key: 'partner2:approved', user: 'partner2', template: 'partner_status_changed', at: '2026-09-01T06:00:00.000Z', data: { from: 'APPROVAL_PENDING', to: 'APPROVED' } },
  {
    key: 'partner4:suspended', user: 'partner4', template: 'partner_status_changed', at: '2026-09-03T05:00:00.000Z',
    data: { from: 'APPROVED', to: 'SUSPENDED', reason: 'Repeated late deliveries (demo)' },
  },
];

/** Customer (and restaurant) in-app history for the demo orders. */
function orderNotifications(): InAppSpec[] {
  const out: InAppSpec[] = [];
  for (const co of DEMO_CHECKOUTS) {
    const checkoutId = ids.checkout(co);
    out.push({
      key: `${co.key}:placed`, user: co.consumer, template: 'order_placed_customer', at: co.placedAt, read: true,
      data: { code: co.code, totalPaise: co.totals.totalPaise, checkoutId },
    });
    for (const c of co.children) {
      const childOrderId = ids.child(co, c);
      const t = demoTimeline(co, c);
      out.push({
        key: `${co.key}:${c.key}:restaurant`, user: c.restaurant.owner, template: 'order_placed_restaurant', at: co.placedAt, read: true,
        data: { code: c.code, totalPaise: c.breakdown.totalPaise, acceptBy: new Date(t.placedAt.getTime() + 300_000).toISOString(), childOrderId, restaurantId: ids.restaurant(c.restaurant) },
      });
      if (c.outcome.kind === 'DELIVERED') {
        out.push({ key: `${co.key}:${c.key}:delivered`, user: co.consumer, template: 'order_delivered', at: t.deliveredAt!.toISOString(), read: true, data: { code: c.code, checkoutId, childOrderId } });
      } else {
        const template = c.outcome.kind === 'REJECTED' ? 'order_rejected' : 'order_cancelled';
        const at = (c.outcome.kind === 'REJECTED' ? t.rejectedAt : t.cancelledAt)!;
        out.push({
          key: `${co.key}:${c.key}:${c.outcome.kind.toLowerCase()}`, user: co.consumer, template, at: at.toISOString(),
          data: { code: c.code, reason: c.outcome.reason, refundPaise: demoRefundPaise(c), checkoutId, childOrderId, ...(c.outcome.kind === 'CANCELLED' ? { actor: 'CUSTOMER' } : {}) },
        });
        out.push({
          key: `${co.key}:${c.key}:refund`, user: co.consumer, template: 'refund_succeeded', at: t.refundSucceededAt!.toISOString(),
          data: { amountPaise: demoRefundPaise(c), checkoutId, childOrderId },
        });
      }
    }
  }
  return out;
}

export async function seedNotifications(conn: Connection): Promise<SeedReport> {
  const report: SeedReport = {};
  await ensureDocs(
    notificationModel(conn),
    [...IN_APP, ...orderNotifications()].map((n) => {
      const at = new Date(n.at);
      const rendered = renderTemplate(n.template, n.data, 'IN_APP');
      return {
        _id: seedId(`notification:${n.key}`),
        userId: seedId(`user:${n.user}`),
        channel: 'IN_APP',
        to: '',
        template: n.template,
        data: { ...n.data, isDemo: true },
        title: rendered.title,
        body: rendered.text,
        status: 'SENT',
        attempts: 1,
        nextAttemptAt: null,
        provider: 'in_app',
        dedupeKey: `seed:${n.key}`,
        readAt: n.read ? new Date(at.getTime() + 600_000) : null,
        sentAt: at,
        createdAt: at,
        updatedAt: at,
      };
    }),
    report,
  );
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({
    service: 'notifications',
    dbName: 'thali_notifications',
    init: async (conn) => {
      await initEventCollections(conn);
      await Promise.all([notificationModel(conn).init(), providerCallbackModel(conn).init()]);
    },
    run: async (conn) => {
      const report = await seedNotifications(conn);
      if (process.env.SEED_BLR === '0') return report;
      return { ...report, ...(await seedNotificationsBlr(conn, buildBlrWorld({ pricing: await loadPricing() }))) };
    },
  });
}
