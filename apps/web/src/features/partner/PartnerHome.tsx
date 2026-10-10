/**
 * Partner home (`/partner`): profile gate -> availability -> active deliveries -> live offers.
 * Owns the location tracking hook so one watch serves the whole screen (and stops on unmount / offline).
 */
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { ButtonLink } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill } from '../../components/ui/StatusPill';
import { isNotFound } from '../../lib/errors';
import { ActiveDelivery } from './ActiveDelivery';
import { listActive, partnerKeys, profileQueryOptions, type PartnerProfile } from './api';
import { OffersList } from './OffersList';
import { OnlineToggle } from './OnlineToggle';
import { TrackingLimitations } from './TrackingLimitations';
import { usePartnerTracking } from './PartnerLayout';

function NotApprovedPanel({ partner }: { partner: PartnerProfile }) {
  const copy: Record<string, { title: string; body: string; cta?: string }> = {
    DRAFT: { title: 'Finish your application', body: 'Add your vehicle, upload your documents and submit for review. You can go online once an admin approves you.', cta: 'Continue application' },
    APPROVAL_PENDING: { title: 'Your application is under review', body: 'An admin is checking your documents. You will be able to go online as soon as you are approved.', cta: 'View application' },
    REJECTED: { title: 'Your application was not approved', body: partner.statusReason ? `Reason: ${partner.statusReason}` : 'Update your details or documents and submit again.', cta: 'Fix and resubmit' },
    SUSPENDED: { title: 'Your account is suspended', body: partner.statusReason ? `Reason: ${partner.statusReason}. Contact Thali support to get reinstated.` : 'Contact Thali support to get reinstated.' },
  };
  const c = copy[partner.status] ?? copy.DRAFT!;
  return (
    <Card tone={partner.status === 'SUSPENDED' || partner.status === 'REJECTED' ? 'danger' : 'warn'}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{c.title}</h2>
        <StatusPill kind="partner" status={partner.status} />
      </div>
      <p className="mt-2 text-[0.9375rem] text-slate-700">{c.body}</p>
      {c.cta ? (
        <ButtonLink to="/partner/onboarding" className="mt-3">
          {c.cta}
        </ButtonLink>
      ) : null}
    </Card>
  );
}

function ApprovedHome({ partner }: { partner: PartnerProfile }) {
  const active = useQuery({ queryKey: partnerKeys.active, queryFn: listActive, refetchInterval: 30_000 });
  const jobs = active.data?.items ?? [];
  const tracking = usePartnerTracking();
  const atCapacity = jobs.length >= partner.maxActive;

  return (
    <div className="space-y-6">
      {partner.isDemo ? (
        <p className="text-sm text-slate-600">
          <Badge tone="info">Demo</Badge> This is a demo account; document checks are labelled, not real verification.
        </p>
      ) : null}
      <OnlineToggle partner={partner} tracking={tracking} activeCount={jobs.length} />

      <section aria-labelledby="active-heading" className="space-y-3">
        <h2 id="active-heading" className="text-lg font-semibold">
          Active deliveries
        </h2>
        <QueryState
          query={active}
          isEmpty={(d) => d.items.length === 0}
          empty={{ icon: 'bike', title: 'No active deliveries', description: partner.online ? 'Accepted offers show up here.' : 'Go online to start receiving offers.', compact: true }}
        >
          {(d) => (
            <div className="space-y-3">
              {d.items.map((j) => (
                <ActiveDelivery key={j.id} job={j} />
              ))}
            </div>
          )}
        </QueryState>
      </section>

      {partner.online ? (
        <OffersList enabled atCapacity={atCapacity} hasActiveJobs={jobs.length > 0} />
      ) : (
        <Card tone="muted">
          <p className="text-sm text-slate-700">You are offline, so you won't receive offers. Switch on availability above to start.</p>
        </Card>
      )}

      <TrackingLimitations />
    </div>
  );
}

export default function PartnerHome() {
  const profile = useQuery(profileQueryOptions());

  return (
    <>
      <PageHeader
        title="Partner home"
        description="Go online, take delivery offers and track your earnings."
        status={profile.data ? <StatusPill kind="partner" status={profile.data.status} /> : undefined}
      />
      {profile.isError && isNotFound(profile.error) ? (
        <EmptyState
          icon="bike"
          title="Set up your delivery partner profile"
          description="Tell us about yourself and your vehicle, upload your documents and we will review your application."
          action={<ButtonLink to="/partner/onboarding">Start onboarding</ButtonLink>}
        />
      ) : (
        <QueryState query={profile}>{(p) => (p.status === 'APPROVED' ? <ApprovedHome partner={p} /> : <NotApprovedPanel partner={p} />)}</QueryState>
      )}
    </>
  );
}
