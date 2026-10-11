/**
 * Shared admin mutations used by more than one screen, so audit-sensitive behaviour (NTF-2 / NTF-3 bulk actions,
 * restaurant approval) cannot drift between the overview and the Health / detail pages.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { plural } from '../../lib/format';
import { qk, replayAllDeadLetters, restaurantAction, retryAllNotifications } from './api';
import { useAdminMutation } from './shared';

/** NTF-3: replay every unreplayed dead letter; the toast reports partial failures with the first reasons. */
export function useReplayAllDeadLetters() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: () => replayAllDeadLetters({}),
    onSuccess: async (r) => {
      toast({
        title: r.failed.length ? `Replayed ${r.replayed}, ${r.failed.length} failed` : `Replayed ${plural(r.replayed, 'dead letter')}`,
        description: r.failed.length ? r.failed.slice(0, 3).map((f) => `${f.service}: ${f.error}`).join(' · ') : undefined,
        tone: r.failed.length ? 'warn' : 'success',
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (e) => toast({ title: "Couldn't replay dead letters", description: errorMessage(e), tone: 'danger' }),
  });
}

export type RetryStatus = 'FAILED' | 'DEAD';

/** What a bulk retry reports: NTF-2 never re-queues one-time codes or notifications without a recipient. */
export function retryOutcome(queued: number, asked: number): { title: string; description?: string } {
  const skipped = Math.max(0, asked - queued);
  return {
    title: skipped ? `${queued} re-queued, ${skipped} not retryable` : `Re-queued ${plural(queued, 'notification')}`,
    description: skipped ? 'One-time codes and notifications without a recipient are never retried.' : undefined,
  };
}

/** NTF-2 for each given status (sequential), `asked` = how many rows the admin saw (NTF-1 counts). */
export function useRetryNotifications() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ statuses }: { statuses: RetryStatus[]; asked: number }) => {
      let queued = 0;
      for (const status of statuses) queued += (await retryAllNotifications({ status })).queued;
      return queued;
    },
    onSuccess: async (queued, { asked }) => {
      toast({ ...retryOutcome(queued, asked), tone: queued < asked ? 'warn' : 'success' });
      await qc.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (e) => toast({ title: "Couldn't retry notifications", description: errorMessage(e), tone: 'danger' }),
  });
}

export { APPROVE_BLOCKED_COPY, APPROVE_RESTAURANT_COPY } from './shared';

/** Approve a restaurant from any screen (overview row, detail page). */
export function useApproveRestaurant() {
  return useAdminMutation(({ id }: { id: string; name: string }) => restaurantAction(id, 'approve'), {
    success: (_d, v) => `${v.name} approved`,
    errorTitle: "Couldn't approve",
    invalidate: [['admin', 'restaurants'], ['admin', 'restaurant'], qk.overview('marketplace') as unknown as unknown[]],
  });
}
