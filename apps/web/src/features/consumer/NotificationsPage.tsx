/**
 * Notifications (design-spec §7.2): rows with an unread --acc dot, title, body, relative time; row → its target
 * (and marks it read); "Mark as read" per row; "Mark all as read" marks every loaded unread row (the API has no
 * bulk endpoint). `GET /notifications` (cursor pages, unreadCount), `POST /notifications/:id/read`; live via SSE.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button, EmptyState, ErrorState, LiveIndicator, LoadMore, PageHeader, SkeletonList, useToast } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { useRealtime } from '../../hooks/useRealtime';
import { errorMessage } from '../../lib/errors';
import { formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
import { fetchNotifications, markNotificationRead, UNREAD_KEY, type InAppNotification } from './api';
import { PageContainer } from './ConsumerLayout';

export const NOTIFICATIONS_KEY = ['notifications', 'list'] as const;

/** Deep link for a notification: checkoutId → order; childOrderId → orders list resolves it; ticket; membership. */
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
  const { toast } = useToast();
  const q = useInfiniteQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => fetchNotifications(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    void qc.invalidateQueries({ queryKey: UNREAD_KEY });
  };
  const { status } = useRealtime(['notification'], () => refresh(), { fallbackRefetch: q.refetch });
  const read = useMutation({ mutationFn: markNotificationRead, onSuccess: refresh });
  const readAll = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await markNotificationRead(id);
    },
    onSettled: refresh,
    onError: (e) => toast({ title: "Couldn't mark everything as read", description: errorMessage(e), tone: 'danger' }),
  });

  if (q.isPending) return <SkeletonList count={4} />;
  if (q.isError && !q.data) return <ErrorState error={q.error} title="Couldn't load notifications" onRetry={() => void q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  const unread = q.data.pages[0]?.unreadCount ?? 0;
  const unreadIds = items.filter((n) => !n.readAt).map((n) => n.id);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-2" aria-live="polite">
          {unread ? `${unread} unread` : 'All caught up'}
        </p>
        <div className="flex items-center gap-3">
          <LiveIndicator status={status} variant="inline" />
          {unreadIds.length ? (
            <Button variant="ghost" size="sm" loading={readAll.isPending} onClick={() => readAll.mutate(unreadIds)}>
              Mark all as read
            </Button>
          ) : null}
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="bell" title="No notifications yet" description="Order updates, refunds and support replies appear here." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
          {items.map((n) => {
            const to = targetOf(n);
            const open = () => {
              if (!n.readAt) read.mutate(n.id);
              if (to) navigate(to);
            };
            return (
              <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3.5', !n.readAt && 'bg-acc-soft/40')}>
                <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-acc')} />
                <button type="button" onClick={open} disabled={!to && !!n.readAt} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default">
                  <span className={cn('text-[14.5px] text-fg', !n.readAt ? 'font-semibold' : 'font-medium')}>
                    {n.title || 'Update'}
                    {!n.readAt ? <span className="sr-only"> (unread)</span> : null}
                  </span>
                  {n.body ? <span className="text-[13px] text-fg-2">{n.body}</span> : null}
                  <time dateTime={n.createdAt} className="text-xs text-fg-3">
                    {formatRelative(n.createdAt)}
                  </time>
                </button>
                {!n.readAt ? (
                  <Button size="xs" variant="ghost" onClick={() => read.mutate(n.id)} disabled={read.isPending && read.variables === n.id}>
                    Mark as read
                  </Button>
                ) : null}
              </li>
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
    <PageContainer width="narrow">
      <PageHeader size="page" title="Notifications" back={{ to: '/account', label: 'Account' }} />
      <RequireAuth signInMessage="Sign in to see your notifications.">
        <NotificationsList />
      </RequireAuth>
    </PageContainer>
  );
}
