/**
 * Partner home aside (board 30, rows 30-28 … 30-30):
 *   Today        PAY-1 window `GET /finance/partner/summary` (default = today IST): deliveries · earned
 *   Last payout  `GET /finance/partner/payouts?limit=1`: amount · status ("Paid" only with a UTR) · UTR · date
 * Stats that fail to load show "—" + Retry, never zeros.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDate, formatINR } from '../../lib/format';
import { getSummary, listPayouts, partnerKeys, type Payout } from './api';
import { formatRupeesShort, groupUtr } from './format';

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <span className="text-xs text-fg-3">
      Couldn’t load ·{' '}
      <button type="button" onClick={onClick} className="font-semibold text-fg underline underline-offset-2">
        Retry
      </button>
    </span>
  );
}

export function TodayCard() {
  const q = useQuery({ queryKey: partnerKeys.summary(), queryFn: () => getSummary(), refetchInterval: 60_000 });
  const w = q.data?.window;
  const unavailable = q.isError || (q.data !== undefined && !w);
  return (
    <section aria-label="Today" className="flex flex-col gap-3 rounded-card border border-line bg-card px-[18px] py-4">
      <h2 className="lbl">Today</h2>
      <dl className="grid grid-cols-2 gap-2.5">
        <div className="flex flex-col-reverse gap-1">
          <dt className="text-[12.5px] text-fg-3">deliveries</dt>
          <dd className="text-2xl font-semibold leading-none tracking-[-0.03em] tabular-nums">
            {q.isPending ? <Skeleton className="h-6 w-10" /> : unavailable ? '—' : w!.deliveries}
          </dd>
        </div>
        <div className="flex flex-col-reverse gap-1">
          <dt className="text-[12.5px] text-fg-3">earned</dt>
          <dd className="text-2xl font-semibold leading-none tracking-[-0.03em] tabular-nums">
            {q.isPending ? <Skeleton className="h-6 w-16" /> : unavailable ? '—' : formatRupeesShort(w!.earningsPaise)}
          </dd>
        </div>
      </dl>
      {unavailable ? <Retry onClick={() => void q.refetch()} /> : null}
      <Link to="/partner/earnings" className="text-[13px] text-fg underline underline-offset-2 hover:text-acc-fg">
        Earnings &amp; payouts →
      </Link>
    </section>
  );
}

/** "Paid" only with a bank reference; a PAID row without one is shown as awaiting its reference. */
export function PayoutStatus({ payout }: { payout: Payout }) {
  if (payout.status === 'PAID' && !payout.utr) return <Badge tone="warn">Awaiting bank reference</Badge>;
  return <StatusPill kind="payout" status={payout.status} />;
}

export function LastPayoutCard() {
  const q = useQuery({ queryKey: partnerKeys.lastPayout, queryFn: () => listPayouts(undefined, 1) });
  const p = q.data?.items[0];
  return (
    <section aria-label="Last payout" className="flex flex-col gap-2.5 rounded-card border border-line bg-card px-[18px] py-4">
      <h2 className="lbl">Last payout</h2>
      {q.isPending ? (
        <>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-40" />
        </>
      ) : q.isError ? (
        <Retry onClick={() => void q.refetch()} />
      ) : !p ? (
        <p className="text-sm text-fg-3">No payouts yet. Thali pays out your available balance by bank transfer.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-base font-semibold tabular-nums">{formatINR(p.amountPaise)}</span>
            <PayoutStatus payout={p} />
          </div>
          <span className="font-mono text-xs text-fg-3">
            {p.utr ? `UTR ${groupUtr(p.utr)}` : p.failureReason ? `Failed: ${p.failureReason}` : 'Bank reference pending'}
            {' · '}
            {formatDate(p.confirmedAt ?? p.createdAt, { day: 'numeric', month: 'short' })}
          </span>
        </>
      )}
    </section>
  );
}
