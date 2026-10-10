/**
 * Partner home `/partner` (board 30). Profile gate:
 *   no profile (404)  → "Set up your delivery partner profile"
 *   not approved      → status banner (Draft / Awaiting approval / Rejected + reason / Suspended) instead of the online card
 *   approved          → online card · [offers · accepted strip · active deliveries] + aside [Today · Last payout · tips]
 * Location sharing is owned by PartnerLayout (usePartnerTracking) so it survives navigation within /partner.
 */
import { useQuery } from '@tanstack/react-query';
import { ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState, SessionExpiredState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBanner } from '../../components/ui/Notice';
import { StatusPill } from '../../components/ui/StatusPill';
import { isNotFound, isUnauthenticated } from '../../lib/errors';
import { ActiveDelivery } from './ActiveDelivery';
import { listActive, partnerKeys, profileQueryOptions, type PartnerProfile } from './api';
import { OffersList } from './OffersList';
import { OnlineToggle } from './OnlineToggle';
import { LastPayoutCard, TodayCard } from './PartnerAside';
import { usePartnerTracking } from './PartnerLayout';
import { TrackingLimitations } from './TrackingLimitations';

const NOT_APPROVED: Record<string, { title: string; body: (p: PartnerProfile) => string; cta?: string; tone: 'info' | 'warn' | 'bad' }> = {
  DRAFT: { title: 'Finish your application', body: () => 'Add your vehicle, upload your documents and submit for review. You can go online once Thali approves you.', cta: 'Continue application', tone: 'warn' },
  APPROVAL_PENDING: { title: 'Your application is under review', body: () => 'Thali is checking your documents. You can go online as soon as you’re approved.', cta: 'View application', tone: 'info' },
  REJECTED: { title: 'Your application wasn’t approved', body: (p) => (p.statusReason ? `Reason: ${p.statusReason}. Fix it and resubmit.` : 'Update your details or documents and submit again.'), cta: 'Fix and resubmit', tone: 'bad' },
  SUSPENDED: { title: 'Your account is suspended', body: (p) => `${p.statusReason ? `Reason: ${p.statusReason}. ` : ''}Contact Thali support to get reinstated.`, tone: 'bad' },
};

function NotApproved({ partner }: { partner: PartnerProfile }) {
  const c = NOT_APPROVED[partner.status] ?? NOT_APPROVED.DRAFT!;
  return (
    <div className="flex flex-col gap-[18px]">
      <h1 className="sr-only">Partner home</h1>
      <StatusBanner
        tone={c.tone}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.title} <StatusPill kind="partner" status={partner.status} />
          </span>
        }
        action={c.cta ? <ButtonLink to="/partner/onboarding">{c.cta}</ButtonLink> : undefined}
      >
        {c.body(partner)}
      </StatusBanner>
      <TrackingLimitations />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-[18px]">
      <span className="sr-only">Loading your partner home…</span>
      <div className="flex items-center gap-4 rounded-card border border-line bg-card px-5 py-[18px]">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-16 rounded-pill" />
      </div>
      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-[999_1_420px] space-y-[18px]">
          <Skeleton className="h-[230px] w-full rounded-card" />
        </div>
        <div className="flex-[1_1_280px] space-y-3.5 lg:max-w-[360px]">
          <Skeleton className="h-[130px] w-full rounded-card" />
          <Skeleton className="h-[100px] w-full rounded-card" />
        </div>
      </div>
    </div>
  );
}

function ApprovedHome({ partner }: { partner: PartnerProfile }) {
  const active = useQuery({ queryKey: partnerKeys.active, queryFn: listActive, refetchInterval: 15_000 });
  const jobs = active.data?.items ?? [];
  const tracking = usePartnerTracking();

  return (
    <div className="flex flex-col gap-[18px]">
      <OnlineToggle partner={partner} tracking={tracking} activeCount={jobs.length} className="max-sm:sticky max-sm:top-14 max-sm:z-20 max-sm:shadow-card" />

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-[18px]">
          {partner.online ? <OffersList enabled activeJobs={jobs} maxActive={partner.maxActive} /> : null}

          {active.isPending ? (
            <Skeleton className="h-[260px] w-full rounded-card" />
          ) : active.isError && !active.data ? (
            isUnauthenticated(active.error) ? (
              <SessionExpiredState />
            ) : (
              <ErrorState error={active.error} title="Couldn’t load your deliveries" onRetry={() => void active.refetch()} retrying={active.isFetching} compact />
            )
          ) : jobs.length ? (
            jobs.map((j, i) => <ActiveDelivery key={j.id} job={j} index={i + 1} total={jobs.length} />)
          ) : (
            <section className="rounded-card border border-line bg-card px-5 py-[18px]" aria-label="Active deliveries">
              <p className="text-[15px] font-semibold">No active delivery</p>
              <p className="mt-1 text-[13.5px] text-fg-3">
                {partner.online ? 'Accept an offer and the delivery steps show up here.' : 'Go online to start receiving delivery offers.'}
              </p>
            </section>
          )}
        </div>

        <aside aria-label="Today and payouts" className="flex min-w-0 flex-[1_1_280px] flex-col gap-3.5 lg:max-w-[360px]">
          <TodayCard />
          <LastPayoutCard />
          <TrackingLimitations />
        </aside>
      </div>
    </div>
  );
}

export default function PartnerHome() {
  const profile = useQuery(profileQueryOptions());

  if (profile.isError && isNotFound(profile.error)) {
    return (
      <>
        <h1 className="sr-only">Partner home</h1>
        <EmptyState
          icon="bike"
          title="Set up your delivery partner profile"
          description="Tell us about yourself and your vehicle, upload your documents and we’ll review your application."
          action={<ButtonLink to="/partner/onboarding">Start onboarding</ButtonLink>}
        />
      </>
    );
  }
  if (!profile.data) {
    if (profile.isError) {
      return isUnauthenticated(profile.error) ? (
        <SessionExpiredState />
      ) : (
        <ErrorState error={profile.error} title="Couldn’t load your partner profile" onRetry={() => void profile.refetch()} retrying={profile.isFetching} />
      );
    }
    return <HomeSkeleton />;
  }
  return profile.data.status === 'APPROVED' ? <ApprovedHome partner={profile.data} /> : <NotApproved partner={profile.data} />;
}
