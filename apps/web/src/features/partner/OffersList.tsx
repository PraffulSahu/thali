/**
 * Live offers: `GET /partner/offers`, refreshed on the realtime `partner.offer` event with polling fallback
 * (useRealtime) plus a slow interval so expired offers drop off even if the stream is quiet.
 * Accept/reject -> `POST /deliveries/offers/:id/accept|reject`. A 409 means someone else got there first.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RealtimeStatus } from '../../components/ui/RealtimeStatus';
import { QueryState } from '../../components/ui/QueryState';
import { useToast } from '../../components/ui/Toast';
import { useRealtime } from '../../hooks/useRealtime';
import { ApiError, errorMessage } from '../../lib/errors';
import { acceptOffer, listOffers, partnerKeys, rejectOffer, type Offer } from './api';
import { OfferCard } from './OfferCard';

export interface OffersListProps {
  /** Poll/subscribe only while online. */
  enabled: boolean;
  /** Active deliveries vs maxActive: shows why accept is unavailable. */
  atCapacity?: boolean;
  /** Partner currently holds at least one delivery (enables the batching verdict badge). */
  hasActiveJobs?: boolean;
}

export function OffersList({ enabled, atCapacity = false, hasActiveJobs = false }: OffersListProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ id: string; action: 'accept' | 'reject' } | null>(null);

  const offers = useQuery({
    queryKey: partnerKeys.offers,
    queryFn: listOffers,
    enabled,
    refetchInterval: enabled ? 20_000 : false,
  });
  const { status } = useRealtime<{ offerId: string }>(['partner.offer'], () => void offers.refetch(), {
    fallbackRefetch: offers.refetch,
    enabled,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    void qc.invalidateQueries({ queryKey: partnerKeys.active });
    void qc.invalidateQueries({ queryKey: partnerKeys.profile });
  };

  const accept = useMutation({
    mutationFn: (o: Offer) => acceptOffer(o.id),
    onSuccess: () => {
      toast({ title: 'Delivery accepted', description: 'Head to the restaurant. It is now in your active deliveries.', tone: 'success' });
      refreshAll();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'OFFER_EXPIRED') {
        toast({ title: 'Offer expired', description: 'This offer ran out or was withdrawn, possibly because another partner accepted it.', tone: 'warn' });
      } else if (e instanceof ApiError && e.status === 409 && e.code !== 'CAPACITY_EXCEEDED') {
        toast({ title: 'Taken by another partner', description: 'That offer is no longer available. Fresh offers appear here automatically.', tone: 'warn' });
      } else {
        toast({ title: "Couldn't accept the offer", description: errorMessage(e), tone: 'danger' });
      }
      refreshAll();
    },
    onSettled: () => setPending(null),
  });
  const reject = useMutation({
    mutationFn: (o: Offer) => rejectOffer(o.id),
    onSuccess: () => {
      toast({ title: 'Offer rejected', tone: 'info' });
      void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    },
    onError: (e) => {
      toast({ title: "Couldn't reject the offer", description: errorMessage(e), tone: 'danger' });
      void qc.invalidateQueries({ queryKey: partnerKeys.offers });
    },
    onSettled: () => setPending(null),
  });

  if (!enabled) return null;

  return (
    <section aria-labelledby="offers-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="offers-heading" className="text-lg font-semibold">
          Delivery offers
        </h2>
        <RealtimeStatus status={status} />
      </div>
      <QueryState
        query={offers}
        isEmpty={(d) => d.items.length === 0}
        empty={{ icon: 'bike', title: 'No offers right now', description: 'Stay online with location sharing on. New offers show up here the moment one is nearby.', compact: true }}
      >
        {(data) => (
          <div className="space-y-3" aria-live="polite">
            {data.items.map((o) => (
              <OfferCard
                key={o.id}
                offer={o}
                hasActiveJobs={hasActiveJobs}
                busy={pending?.id === o.id ? pending.action : null}
                acceptDisabledReason={atCapacity ? 'You are at your active delivery limit. Finish a delivery to accept more.' : null}
                onExpire={() => void offers.refetch()}
                onAccept={(offer) => {
                  setPending({ id: offer.id, action: 'accept' });
                  accept.mutate(offer);
                }}
                onReject={(offer) => {
                  setPending({ id: offer.id, action: 'reject' });
                  reject.mutate(offer);
                }}
              />
            ))}
          </div>
        )}
      </QueryState>
    </section>
  );
}
