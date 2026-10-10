/**
 * Notifications demo seed (APP_MODE=demo only; idempotent; writes only thali_notifications).
 *
 *   container:  docker compose exec notifications node dist/seed.js
 *   local:      npm run seed -w @thali/notifications
 *
 * In-app inbox history that matches the other seeds' story (restaurant approvals, partner approvals and a
 * suspension). Rendered with the real templates and stored as already SENT, so the worker never re-sends
 * them. Ids: `notification:<key>`; dedupe keys `seed:<key>`. Order notifications come with the orders seed.
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { initEventCollections } from '@thali/service-kit';
import { ensureDocs, isMainModule, runSeedCli, type SeedReport } from '@thali/service-kit/seed';
import { renderTemplate, type TemplateName } from './domain/templates.js';
import { notificationModel } from './models/notification.js';
import { providerCallbackModel } from './models/provider-callback.js';

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

export async function seedNotifications(conn: Connection): Promise<SeedReport> {
  const report: SeedReport = {};
  await ensureDocs(
    notificationModel(conn),
    IN_APP.map((n) => {
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
    run: seedNotifications,
  });
}
