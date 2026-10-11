/**
 * Live offers (board 30): `GET /partner/offers`, refreshed on the realtime `partner.offer` event with the polling
 * fallback (useRealtime) plus a slow interval so withdrawn offers drop off even if the stream is quiet.
 *   Accept  → `POST /deliveries/offers/:id/accept`  · 409 ASSIGNMENT_TAKEN → "Taken by another partner",
 *             409 OFFER_EXPIRED → "Offer expired", 409 CAPACITY_EXCEEDED → inline reason; success → accepted strip
 *   Decline → `POST /deliveries/offers/:id/reject`  → "Declined"
 * Closed offers stay visible as the muted bar for a few seconds, then leave.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { InlineError } from '../../components/ui/ErrorState';
import { Icon } from '../../components/ui/Icon';
import { LiveIndicator } from '../../components/ui/LiveIndicator';
import { Skeleton } from '../../components/ui/Skeleton';
import { useRealtime } from '../../hooks/useRealtime';
import { ApiError, isNotFound } from '../../lib/errors';
import { acceptOffer, listOffers, navigationUrl, partnerKeys, rejectOffer, type Offer, type PartnerJob } from './api';
import { OfferCard, type OfferClosedReason } from './OfferCard';

/** How long a closed offer keeps its muted bar before it leaves the screen. */
export const CLOSED_LINGER_MS = 6_000;

export interface OffersListProps {
  /** Poll/subscribe only while online. */
  enabled: boolean;
  /** Active deliveries the partner holds now. */
  activeJobs: PartnerJob[];
  /** Server capacity (partner.maxActive). */
  maxActive: number;
}

interface Closed {
  offer: Offer;
  reason: OfferClosedReason;
}

interface Accepted {
  job: PartnerJob;
  position: number;
}

function AcceptedStrip({ accepted, onDismiss }: { accepted: Accepted; onDismiss: () => void }) {
  const { job, position } = accepted;
  const url = job.navigation.pickupUrl || navigationUrl(job.pickup.location);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-card px-5 py-4 animate-in max-sm:px-4" role="status" data-testid="accepted-strip">
      <span className="inline-flex h-6 items-center gap-1.5 rounded-pill bg-ok-bg px-[9px] text-xs font-bold text-ok">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" />
        Accepted
      </span>
      <span className="min-w-[180px] flex-1 text-[14.5px]">
        {position > 1
          ? `Added as delivery ${position} · head to ${job.pickup.name} after your current drop`
          : `Head to ${job.pickup.name} · ${job.pickup.address}`}
      </span>
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Navigate to ${job.pickup.name} (opens Google Maps)`} className="inline-flex h-10 items-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-bold hover:border-line-2">
        Navigate
      </a>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid size-8 place-items-center rounded-full text-fg-3 hover:bg-fill hover:text-fg">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function OffersList({ enabled, activeJobs, maxActive }: OffersListProps) {
  const qc = useQueryClient();
  const [closed, setClosed] = useState<Record<string, Closed>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [pending, setPending] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const offers = useQuery({
    queryKey: partnerKeys.offers,
    queryFn: listOffers,
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
  const { status } = useRealtime<{ offerId: string }>(['partner.offer'], () => void offers.refetch(), {
    fallbackRefetch: offers.refetch,
    enabled,
  });

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  // The accepted strip leaves once that delivery has moved past "head to the restaurant".
  const acceptedJob = accepted ? activeJobs.find((j) => j.id === accepted.job.id) : undefined;
  useEffect(() => {
    if (accepted && acceptedJob && acceptedJob.status !== 'ASSIGNED') setAccepted(null);
  }, [accepted, acceptedJob]);

  // The device clock never closes an offer: when the ring reaches 0 we refetch, and an offer is shown as
  // "Offer expired" only once the server stops listing it (accept/decline remain the server's call meanwhile).
  const seen = useRef(new Map<string, Offer>());
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!offers.data) return;
    const now = new Map(offers.data.items.map((o) => [o.id, o] as const));
    for (const [id, o] of seen.current) {
      if (!now.has(id) && !handled.current.has(id)) close(o, 'expired');
    }
    seen.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` only touches state setters and refs
  }, [offers.data]);

  const close = (offer: Offer, reason: OfferClosedReason) => {
    handled.current.add(offer.id);
    setClosed((c) => (c[offer.id] ? c : { ...c, [offer.id]: { offer, reason } }));
    const prev = timers.current.get(offer.id);
    if (prev) clearTimeout(prev);
    timers.current.set(
      offer.id,
      setTimeout(() => {
        timers.current.delete(offer.id);
        setClosed(({ [offer.id]: _gone, ...rest }) => rest);
      }, CLOSED_LINGER_MS),
    );
  };
  const setError = (id: string, e: unknown) => setErrors((m) => ({ ...m, [id]: e }));

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    void qc.invalidateQueries({ queryKey: partnerKeys.active });
    void qc.invalidateQueries({ queryKey: partnerKeys.profile });
  };

  const accept = useMutation({
    mutationFn: (o: Offer) => acceptOffer(o.id),
    onSuccess: (res, o) => {
      handled.current.add(o.id);
      setAccepted({ job: res.job, position: activeJobs.length + 1 });
      setClosed(({ [o.id]: _gone, ...rest }) => rest);
      qc.setQueryData<{ items: Offer[] }>(partnerKeys.offers, (d) => (d ? { items: d.items.filter((x) => x.id !== o.id) } : d));
      refreshAll();
    },
    onError: (e, o) => {
      if (e instanceof ApiError && e.code === 'ASSIGNMENT_TAKEN') close(o, 'taken');
      else if ((e instanceof ApiError && e.code === 'OFFER_EXPIRED') || isNotFound(e)) close(o, 'expired');
      else setError(o.id, e);
      refreshAll();
    },
    onSettled: () => setPending(null),
  });
  const decline = useMutation({
    mutationFn: (o: Offer) => rejectOffer(o.id),
    onSuccess: (_r, o) => {
      close(o, 'declined');
      void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    },
    onError: (e, o) => {
      if ((e instanceof ApiError && e.code === 'OFFER_EXPIRED') || isNotFound(e)) close(o, 'expired');
      else setError(o.id, e);
      void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    },
    onSettled: () => setPending(null),
  });

  if (!enabled) return null;

  const serverOffers = offers.data?.items ?? [];
  const closedList = Object.values(closed);
  const open = serverOffers.filter((o) => !closed[o.id]);
  const atCapacity = activeJobs.length >= maxActive;
  const capacityReason = atCapacity ? `You’re carrying ${activeJobs.length} of ${maxActive} deliveries. Finish one to accept more.` : null;

  return (
    <>
      {offers.isPending ? (
        <div role="status" aria-label="Loading offers" className="rounded-card border border-line bg-card px-5 py-[18px]">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-7 w-56" />
          <Skeleton className="mt-5 h-[50px] w-full rounded-control" />
        </div>
      ) : offers.isError && !offers.data ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-card px-5 py-4">
          <InlineError error={offers.error} className="flex-1" />
          <Button variant="outline" size="sm" icon="refresh" onClick={() => void offers.refetch()} loading={offers.isFetching}>
            Retry
          </Button>
        </div>
      ) : null}

      {status === 'polling' || status === 'reconnecting' ? <LiveIndicator status={status} variant="inline" /> : null}

      {/* assertive: a new offer is time-critical */}
      <div aria-live="assertive" className="contents">
        {open.map((o, i) => (
          <OfferCard
            key={o.id}
            offer={o}
            activeCount={activeJobs.length}
            sheet={i === 0}
            busy={pending?.id === o.id ? pending.action : null}
            acceptDisabledReason={capacityReason}
            error={errors[o.id]}
            onExpire={() => void offers.refetch()}
            onAccept={(offer) => {
              setError(offer.id, null);
              setPending({ id: offer.id, action: 'accept' });
              accept.mutate(offer);
            }}
            onDecline={(offer) => {
              setError(offer.id, null);
              setPending({ id: offer.id, action: 'decline' });
              decline.mutate(offer);
            }}
          />
        ))}
        {closedList.map((c) => (
          <OfferCard key={c.offer.id} offer={c.offer} activeCount={activeJobs.length} closed={c.reason} onAccept={() => undefined} onDecline={() => undefined} />
        ))}
      </div>

      {offers.data && open.length === 0 && closedList.length === 0 && !accepted ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-line-2 px-5 py-4 text-[13.5px] text-fg-3" data-testid="no-offers">
          <Icon name="bike" size={18} />
          <span className="min-w-[200px] flex-1">
            {atCapacity ? 'You’re at your delivery limit, so no new offers for now.' : 'No offers right now. Stay online with Thali open — offers nearby appear here instantly.'}
          </span>
          <LiveIndicator status={status} variant="inline" />
        </div>
      ) : null}

      {accepted ? <AcceptedStrip accepted={acceptedJob ? { ...accepted, job: acceptedJob } : accepted} onDismiss={() => setAccepted(null)} /> : null}
    </>
  );
}
