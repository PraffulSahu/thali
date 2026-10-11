/**
 * Notifications slice of the Bengaluru dataset (`@thali/contracts/seed-blr`): in-app inbox history for the
 * last week of generated orders (customer: placed / delivered / rejected / cancelled / refund; owner: new
 * order) plus status changes of recently approved / pending restaurants and partners. Rendered with the real
 * templates and stored as SENT (the worker never re-sends them); dedupe keys `seed:blr:<key>`. Bulk + idempotent.
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import type { BlrWorld } from '@thali/contracts/seed-blr';
import { ensureDocsBulk, type SeedReport } from '@thali/service-kit/seed';
import { renderTemplate, type TemplateName } from './domain/templates.js';
import { notificationModel } from './models/notification.js';

interface Spec {
  key: string;
  userId: string;
  template: TemplateName;
  data: Record<string, unknown>;
  at: Date;
  read: boolean;
}

function* specs(w: BlrWorld): Generator<Spec> {
  const recentRead = (at: Date) => w.anchor.getTime() - at.getTime() > 2 * 86_400_000;
  for (const co of w.checkouts) {
    if (co.dayAgo > 6) continue;
    const checkoutId = co.id;
    const u = co.consumer.id;
    yield { key: `${co.n}:placed`, userId: u, template: 'order_placed_customer', at: co.placedAt, read: true, data: { code: co.code, totalPaise: co.totals.totalPaise, checkoutId } };
    for (const ch of co.children) {
      const t = ch.timeline;
      const childOrderId = ch.id;
      yield {
        key: `${co.n}:${ch.c}:restaurant`, userId: ch.restaurant.ownerUserId, template: 'order_placed_restaurant', at: t.placedAt, read: true,
        data: { code: ch.code, totalPaise: ch.breakdown.totalPaise, acceptBy: new Date(t.placedAt.getTime() + 300_000).toISOString(), childOrderId, restaurantId: ch.restaurant.id },
      };
      if (ch.outcome.kind === 'DELIVERED') {
        yield { key: `${co.n}:${ch.c}:delivered`, userId: u, template: 'order_delivered', at: t.deliveredAt!, read: recentRead(t.deliveredAt!), data: { code: ch.code, checkoutId, childOrderId } };
        continue;
      }
      const rejected = ch.outcome.kind === 'REJECTED';
      const at = (rejected ? t.rejectedAt : t.cancelledAt)!;
      yield {
        key: `${co.n}:${ch.c}:${rejected ? 'rejected' : 'cancelled'}`, userId: u, template: rejected ? 'order_rejected' : 'order_cancelled', at, read: recentRead(at),
        data: { code: ch.code, reason: ch.outcome.reason, refundPaise: ch.refundPaise, checkoutId, childOrderId, ...(rejected ? {} : { actor: 'CUSTOMER' }) },
      };
      yield { key: `${co.n}:${ch.c}:refund`, userId: u, template: 'refund_succeeded', at: t.refundSucceededAt!, read: recentRead(t.refundSucceededAt!), data: { amountPaise: ch.refundPaise, checkoutId, childOrderId } };
    }
  }
  for (const r of w.restaurants) {
    if (r.createdDaysAgo > 30) continue;
    const created = w.daysAgo(r.createdDaysAgo, -r.i % 600);
    const at = (h: number) => new Date(created.getTime() + h * 3_600_000);
    const base = { restaurantId: r.id, name: r.name };
    if (r.status !== 'VERIFICATION_PENDING') yield { key: `restaurant:${r.i}:submitted`, userId: r.ownerUserId, template: 'restaurant_status_changed', at: at(2), read: true, data: { ...base, from: 'VERIFICATION_PENDING', to: 'APPROVAL_PENDING' } };
    if (r.status === 'APPROVED') yield { key: `restaurant:${r.i}:approved`, userId: r.ownerUserId, template: 'restaurant_status_changed', at: at(20), read: r.createdDaysAgo > 7, data: { ...base, from: 'APPROVAL_PENDING', to: 'APPROVED' } };
    if (r.status === 'REJECTED') yield { key: `restaurant:${r.i}:rejected`, userId: r.ownerUserId, template: 'restaurant_status_changed', at: at(26), read: false, data: { ...base, from: 'APPROVAL_PENDING', to: 'REJECTED', reason: r.statusReason } };
  }
  for (const p of w.partners) {
    if (p.status === 'SUSPENDED') yield { key: `partner:${p.k}:suspended`, userId: p.id, template: 'partner_status_changed', at: w.daysAgo(2 + (p.k % 9)), read: false, data: { from: 'APPROVED', to: 'SUSPENDED', reason: p.statusReason } };
    if (p.status === 'REJECTED') {
      const created = w.daysAgo(p.createdDaysAgo, -p.k);
      yield { key: `partner:${p.k}:rejected`, userId: p.id, template: 'partner_status_changed', at: new Date(created.getTime() + 30 * 3_600_000), read: true, data: { from: 'APPROVAL_PENDING', to: 'REJECTED', reason: p.statusReason } };
    }
  }
}

export async function seedNotificationsBlr(conn: Connection, w: BlrWorld): Promise<SeedReport> {
  const report: SeedReport = {};
  await ensureDocsBulk(notificationModel(conn), (function* () {
    for (const n of specs(w)) {
      const rendered = renderTemplate(n.template, n.data, 'IN_APP');
      yield {
        _id: seedId(`blr:notification:${n.key}`),
        userId: n.userId,
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
        dedupeKey: `seed:blr:${n.key}`,
        readAt: n.read ? new Date(n.at.getTime() + 600_000) : null,
        sentAt: n.at,
        createdAt: n.at,
        updatedAt: n.at,
      };
    }
  })(), report, { label: 'notifications (blr)' });
  return report;
}
