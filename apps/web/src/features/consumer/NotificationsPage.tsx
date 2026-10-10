/** In-app notifications: `GET /notifications` (cursor pages, unreadCount), `POST /notifications/:id/read`; live via SSE `notification`. */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Badge, Button, Card, EmptyState, ErrorState, Icon, LoadMore, PageHeader, RealtimeStatus, SkeletonList } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { useRealtime } from '../../hooks/useRealtime';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
import { fetchNotifications, type InAppNotification } from './api';

export const NOTIFICATIONS_KEY = ['notifications'] as const;

/**
 * Deep link for a notification. Customer order templates currently carry no ids (notifications handlers send
 * `{code, totalPaise}` etc.), so: checkoutId → order; childOrderId → orders list resolves the child; any
 * other order_* template → orders list.
 */
export function targetOf(n: InAppNotification): string | null {
  const d = n.data ?? {};
  if (typeof d.checkoutId === 'string') return `/orders/${d.checkoutId}`;
  if (typeof d.childOrderId === 'string') return `/orders?child=${encodeURIComponent(d.childOrderId)}`;
  if (typeof d.ticketId === 'string') return `/support/${d.ticketId}`;
  if (n.template.startsWith('membership')) return '/membership';
  if (n.template.startsWith('order_')) return '/orders';
  return null;
}

function NotificationsList() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useInfiniteQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => fetchNotifications(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const { status } = useRealtime(['notification'], () => void q.refetch(), { fallbackRefetch: q.refetch });
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  if (q.isPending) return <SkeletonList count={4} />;
  if (q.isError && !q.data) return <ErrorState error={q.error} title="Couldn't load notifications" onRetry={() => void q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  const unread = q.data.pages[0]?.unreadCount ?? 0;
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-700">{unread ? <Badge tone="brand">{unread} unread</Badge> : 'All caught up'}</p>
        <RealtimeStatus status={status} />
      </div>
      {items.length === 0 ? (
        <EmptyState icon="bell" title="No notifications yet" description="Order updates, refunds and support replies appear here." />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const to = targetOf(n);
            return (
              <Card as="li" key={n.id} padding="sm" className={cn('list-none', !n.readAt && 'border-brand-200 bg-brand-50/40')}>
                <div className="flex items-start gap-3">
                  <Icon name="bell" size={18} className={cn('mt-0.5', n.readAt ? 'text-slate-400' : 'text-brand-600')} />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-slate-900', !n.readAt && 'font-semibold')}>{n.title || 'Update'}</p>
                    {n.body ? <p className="text-sm text-slate-700">{n.body}</p> : null}
                    <p className="text-xs text-slate-500">
                      <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {to ? (
                      <Button
                        size="sm"
                        variant="link"
                        onClick={() => {
                          if (!n.readAt) read.mutate(n.id);
                          navigate(to);
                        }}
                      >
                        View
                      </Button>
                    ) : null}
                    {!n.readAt ? (
                      <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)} disabled={read.isPending && read.variables === n.id}>
                        Mark read
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </ul>
      )}
      <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </>
  );
}

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="Notifications" back={{ to: '/account', label: 'Account' }} />
      <RequireAuth signInMessage="Sign in to see your notifications.">
        <NotificationsList />
      </RequireAuth>
    </>
  );
}
