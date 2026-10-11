/**
 * One delivery offer (board 30, rows 30-11 … 30-18).
 *   header   tag "New offer · would be your 2nd delivery" · "3.2 km · ~18 min" (EST.) · countdown ring (red ≤10 s)
 *   body     Pickup · restaurant + address · Drop · AREA ONLY + "Full address after pickup" (DLV-2)
 *            fit box (2nd simultaneous delivery only): the server's batching reasons, ✓ / ✗
 *   footer   Decline / Accept offer — or the muted closed bar (Offer expired · Declined · Taken by another partner)
 * The server stays the authority: accept/decline still answer 409 after the ring hits 0.
 */
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { CountdownRing } from '../../components/ui/CountdownRing';
import { EstBadge } from '../../components/ui/EstBadge';
import { InlineError } from '../../components/ui/ErrorState';
import { cn } from '../../lib/cn';
import { formatDistanceKm } from '../../lib/format';
import type { Offer } from './api';
import { fitReasons, OFFER_WINDOW_SEC, ordinal } from './format';

export type OfferClosedReason = 'expired' | 'declined' | 'taken';
export const CLOSED_LABEL: Record<OfferClosedReason, string> = {
  expired: 'Offer expired',
  declined: 'Declined',
  taken: 'Taken by another partner',
};

/** Estimate source note (demo/straight-line) next to the EST. badge. */
export function estimateNote(source: string): string | null {
  if (source === 'DEMO_HAVERSINE') return 'Demo estimate';
  if (source === 'HAVERSINE_FALLBACK') return 'Straight-line estimate';
  return null;
}

export interface OfferCardProps {
  offer: Offer;
  /** Deliveries the partner already holds (drives "would be your 2nd delivery" and the fit box). */
  activeCount: number;
  closed?: OfferClosedReason | null;
  busy?: 'accept' | 'decline' | null;
  /** Accept unavailable, with the reason (e.g. at capacity). */
  acceptDisabledReason?: string | null;
  error?: unknown;
  onAccept: (offer: Offer) => void;
  onDecline: (offer: Offer) => void;
  onExpire?: (offer: Offer) => void;
  /** ≤640: present as a bottom sheet over the active delivery (design-spec §6.5). */
  sheet?: boolean;
}

export function OfferCard({ offer, activeCount, closed = null, busy = null, acceptDisabledReason, error, onAccept, onDecline, onExpire, sheet }: OfferCardProps) {
  const { job, batchEvaluation: batch } = offer;
  const isNew = closed === null;
  // Ring total: the 45 s offer window, or longer if the server granted more when we first saw it.
  const [total] = useState(() => {
    const left = offer.expiresAt ? Math.ceil((new Date(offer.expiresAt).getTime() - Date.now()) / 1000) : OFFER_WINDOW_SEC;
    return Math.max(OFFER_WINDOW_SEC, left);
  });
  const batched = activeCount > 0;
  const tag = !isNew ? 'Offer closed' : batched ? `New offer · would be your ${ordinal(activeCount + 1)} delivery` : 'New offer';
  const reasons = batched ? fitReasons(batch.reasons) : [];
  const note = job ? estimateNote(job.estimateSource) : null;
  const pickupName = job?.pickup.name ?? 'Restaurant';
  const headingId = `offer-${offer.id}-title`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="offer-card"
      className={cn(
        'overflow-hidden rounded-card border bg-card animate-in',
        isNew ? 'border-acc' : 'border-line',
        sheet && isNew && 'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-[calc(56px+env(safe-area-inset-bottom))] max-sm:z-40 max-sm:max-h-[80dvh] max-sm:overflow-y-auto max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:shadow-float max-sm:animate-sheet-up',
      )}
    >
      {sheet && isNew ? <span aria-hidden="true" className="mx-auto mt-2 block h-1 w-9 rounded-full bg-line-2 sm:hidden" /> : null}
      <div className="flex justify-between gap-4 border-b border-line px-5 py-[18px] max-sm:px-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="lbl">{tag}</span>
          <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-sans text-[26px] font-semibold leading-tight tracking-[-0.03em] max-sm:text-[22px]">
            <span className="sr-only">Delivery offer from {pickupName}: </span>
            {job ? (
              <>
                <span className="tabular-nums">{formatDistanceKm(job.distanceKm)}</span>
                <span aria-hidden="true">·</span>
                <span className="accent-word tabular-nums">~{job.estimatedMinutes} min</span>
                <EstBadge className="self-center" />
              </>
            ) : (
              'New delivery'
            )}
          </h2>
          {note ? <span className="text-xs text-fg-3">{note}</span> : null}
        </div>
        {isNew ? (
          <CountdownRing
            to={offer.expiresAt}
            totalSec={total}
            variant="offer"
            label="to accept the offer"
            onExpire={() => onExpire?.(offer)}
          />
        ) : null}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-4 px-5 py-4 max-sm:px-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2.5">
            <span aria-hidden="true" className="mt-[5px] size-[9px] shrink-0 rounded-full bg-fg" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14.5px] font-medium">Pickup · {pickupName}</span>
              {job ? (
                <span className="text-[13px] text-fg-3">
                  {job.pickup.address}
                  <span className="whitespace-nowrap"> · {formatDistanceKm(offer.distanceToPickupKm)} from you</span>
                </span>
              ) : null}
            </span>
          </div>
          <div className="flex gap-2.5">
            <span aria-hidden="true" className="mt-[5px] size-[9px] shrink-0 rounded-[2px] bg-acc" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14.5px] font-medium">Drop · {job?.drop.area ?? 'Area not shared'}</span>
              <span className="text-[13px] text-fg-3">Full address after pickup</span>
            </span>
          </div>
        </div>
        {reasons.length ? (
          <div className={cn('flex flex-col gap-1.5 rounded-control px-3.5 py-3', batch.eligible ? 'bg-ok-bg' : 'bg-bad-bg')} data-testid="fit-box">
            <span className={cn('text-[13px] font-medium', batch.eligible ? 'text-ok' : 'text-bad')}>
              {batch.eligible ? 'Fits with your current delivery' : 'Doesn’t fit your current delivery'}
            </span>
            <ul className="flex flex-col gap-1.5">
              {reasons.map((r, i) => (
                <li key={`${i}-${r.text}`} className={cn('font-mono text-[12.5px]', r.ok ? 'text-ok' : 'text-bad')}>
                  <span aria-hidden="true">{r.ok ? '✓' : '✗'} </span>
                  <span className="sr-only">{r.ok ? 'Passes: ' : 'Fails: '}</span>
                  {r.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="px-5 pb-[18px] max-sm:px-4 max-sm:pb-[max(18px,env(safe-area-inset-bottom))]" aria-live="polite">
        {isNew ? (
          <>
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <Button variant="outline" shape="block" className="h-[50px]" onClick={() => onDecline(offer)} disabled={busy !== null} loading={busy === 'decline'}>
                Decline
              </Button>
              <Button
                shape="block"
                variant="primary"
                className="h-[50px] text-[15px]"
                onClick={() => onAccept(offer)}
                disabled={busy !== null || Boolean(acceptDisabledReason)}
                loading={busy === 'accept'}
              >
                Accept offer
              </Button>
            </div>
            {acceptDisabledReason ? (
              <p className="mt-2 text-[13px] text-warn" role="note">
                {acceptDisabledReason}
              </p>
            ) : null}
            <InlineError error={error} className="mt-2" />
          </>
        ) : (
          <div role="status" className="flex h-[50px] items-center justify-center rounded-control bg-fill text-sm font-medium text-fg-3">
            {CLOSED_LABEL[closed]}
          </div>
        )}
      </div>
    </section>
  );
}
