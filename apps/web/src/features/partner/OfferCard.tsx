/**
 * One live delivery offer: pickup/drop, distances, a countdown to expiry and the explainable batching
 * evaluation (reasons come straight from the delivery service, e.g. "pickup 0.8km ≤ 1.5km ✓").
 * Accept/reject are disabled once the offer has expired (server enforces it too).
 */
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Countdown, useCountdown } from '../../components/ui/Countdown';
import { Icon } from '../../components/ui/Icon';
import { formatDistanceKm, formatMinutes } from '../../lib/format';
import type { Offer } from './api';

export function EstimateBadge({ source }: { source: string }) {
  if (source === 'DEMO_HAVERSINE') return <Badge tone="info">Demo estimate</Badge>;
  if (source === 'HAVERSINE_FALLBACK') return <Badge tone="neutral">Straight-line estimate</Badge>;
  return null;
}

export interface OfferCardProps {
  offer: Offer;
  onAccept: (offer: Offer) => void;
  onReject: (offer: Offer) => void;
  /** Which action is in flight for this offer. */
  busy?: 'accept' | 'reject' | null;
  /** Disable accepting for a reason shown to the partner (e.g. at capacity). */
  acceptDisabledReason?: string | null;
  onExpire?: () => void;
}

export function OfferCard({ offer, onAccept, onReject, busy = null, acceptDisabledReason, onExpire }: OfferCardProps) {
  const left = useCountdown(offer.expiresAt);
  const expired = left === 0;
  const { job, batchEvaluation: batch } = offer;
  const heading = `Offer from ${job?.pickup.name ?? 'restaurant'}`;
  const reasonsId = `offer-${offer.id}-reasons`;

  return (
    <Card as="article" aria-label={heading} tone={expired ? 'muted' : 'default'} className={expired ? 'opacity-80' : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">{job?.pickup.name ?? 'New delivery'}</h3>
          <p className="text-sm text-slate-600">{job?.pickup.address}</p>
        </div>
        <div className="shrink-0 text-right text-sm">
          <Countdown to={offer.expiresAt} expiredLabel="Offer expired" label="Time left to accept" onExpire={onExpire} />
        </div>
      </div>

      {job ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-600">To pickup</dt>
            <dd className="font-medium tabular-nums">{formatDistanceKm(offer.distanceToPickupKm)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Pickup to drop</dt>
            <dd className="font-medium tabular-nums">{formatDistanceKm(job.distanceKm)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Estimated time</dt>
            <dd className="font-medium tabular-nums">{formatMinutes(job.estimatedMinutes)}</dd>
          </div>
          <div>
            <dt className="text-slate-600">Drop area</dt>
            <dd className="font-medium">{job.drop.address}</dd>
          </div>
        </dl>
      ) : null}
      {job ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <EstimateBadge source={job.estimateSource} />
        </p>
      ) : null}

      <section aria-labelledby={reasonsId} className="mt-3 rounded-control bg-surface-muted p-3">
        <h4 id={reasonsId} className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Icon name="list" size={16} />
          Batching check
          <Badge tone={batch.eligible ? 'success' : 'warn'}>{batch.eligible ? 'Can batch with your current run' : 'Not batchable'}</Badge>
        </h4>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {batch.reasons.map((r) => (
            <li key={r} className="tabular-nums">
              {r}
            </li>
          ))}
        </ul>
        {batch.extraMinutes > 0 ? <p className="mt-1 text-xs text-slate-600">Adds about {formatMinutes(batch.extraMinutes)} to your current delivery.</p> : null}
      </section>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => onReject(offer)} disabled={expired || busy !== null} loading={busy === 'reject'}>
          Reject
        </Button>
        <Button onClick={() => onAccept(offer)} disabled={expired || busy !== null || Boolean(acceptDisabledReason)} loading={busy === 'accept'}>
          Accept delivery
        </Button>
      </div>
      {acceptDisabledReason && !expired ? (
        <p className="mt-2 text-sm text-warn-800" role="note">
          {acceptDisabledReason}
        </p>
      ) : null}
    </Card>
  );
}
