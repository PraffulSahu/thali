/** User-facing in-app notifications (LLD §10): `GET /notifications`, `POST /notifications/:id/read`. */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { PAGE_SORT, buildPage, cursorFilter, requireAuth, validate } from '@thali/service-kit';
import type { NotificationDoc, NotificationModel } from '../models/notification.js';
import { IdParams, InAppListQuery } from '../openapi.js';

const view = (n: NotificationDoc & { _id: unknown }) => ({
  id: String(n._id),
  template: n.template,
  title: n.title ?? '',
  body: n.body ?? '',
  data: n.data ?? {},
  readAt: n.readAt ? n.readAt.toISOString() : null,
  createdAt: n.createdAt.toISOString(),
});

export function notificationsRouter(deps: { Notification: NotificationModel; now: () => Date }): Router {
  const { Notification, now } = deps;
  const r = express.Router();
  const vList = validate({ query: InAppListQuery });
  const vRead = validate({ params: IdParams });

  r.get('/', requireAuth(), vList, async (req, res) => {
    const { query } = vList.get(req);
    const userId = req.auth!.userId;
    const base = { userId, channel: 'IN_APP' as const };
    const [docs, unreadCount] = await Promise.all([
      Notification.find({ ...base, ...(query.unread === 'true' ? { readAt: null } : {}), ...cursorFilter(query.cursor) })
        .sort(PAGE_SORT)
        .limit(query.limit + 1)
        .lean(),
      Notification.countDocuments({ ...base, readAt: null }),
    ]);
    res.json({ ...buildPage(docs, query.limit, view), unreadCount });
  });

  r.post('/:id/read', requireAuth(), vRead, async (req, res) => {
    const { params } = vRead.get(req);
    const own = { _id: params.id, userId: req.auth!.userId, channel: 'IN_APP' as const };
    await Notification.updateOne({ ...own, readAt: null }, { $set: { readAt: now(), updatedAt: now() } });
    const doc = await Notification.findOne(own, { readAt: 1 }).lean();
    if (!doc) throw new DomainError('NOT_FOUND', 'Notification not found');
    res.json({ id: params.id, readAt: doc.readAt!.toISOString() });
  });

  return r;
}
