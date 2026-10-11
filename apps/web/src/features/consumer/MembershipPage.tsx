/**
 * Thali Plus (design-spec §7.2; PRD C-13): current membership card (Active chip, valid till, free-deliveries
 * progress bar), plan cards with visible terms and "Buy" (disabled with the reason while one is active), and the
 * purchase history. Buying creates a PENDING_PAYMENT membership + payment intent (`POST /memberships/purchase`,
 * Idempotency-Key per attempt) and reuses the checkout payment step. Activation is server-side; on return
 * (`?payment=<intentId>`) we poll until the server reports it ACTIVE. Guests can read plans and sign in to buy.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  InfoNotice,
  InlineError,
  PageHeader,
  Price,
  ProgressBar,
  Skeleton,
  SkeletonCard,
  Spinner,
  StatusPill,
} from '../../components/ui';
import { usePolling } from '../../hooks/usePolling';
import { newIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useAuth } from '../../lib/auth';
import { ApiError } from '../../lib/errors';
import { formatBps, formatDate, formatINR } from '../../lib/format';
import { fetchMyMemberships, fetchPlans, MEMBERSHIP_KEY, normalizePayment, purchaseMembership, type MembershipPlan } from './api';
import { PageContainer } from './ConsumerLayout';
import { LoginDialog } from './LoginDialog';
import { Accent } from './parts';
import { usePaymentLauncher } from './PaymentStep';

export function benefitLines(p: Pick<MembershipPlan, 'benefits' | 'durationDays'>): string[] {
  const b = p.benefits;
  const out: string[] = [];
  if (b.freeDeliveriesPerPeriod) {
    out.push(`${b.freeDeliveriesPerPeriod} free deliveries${b.freeDeliveryMinOrderPaise ? ` on restaurant orders above ${formatINR(b.freeDeliveryMinOrderPaise)}` : ''}`);
  }
  if (b.extraDiscountBps) out.push(`Extra ${formatBps(b.extraDiscountBps)} off${b.extraDiscountCapPaise ? ` (up to ${formatINR(b.extraDiscountCapPaise)} per order)` : ''}`);
  out.push(`Valid for ${p.durationDays} days from payment · prepaid, no auto-renewal`);
  return out;
}

function PlanCard({ plan, current, blockedReason, onBuy, buying }: { plan: MembershipPlan; current: boolean; blockedReason: string | null; onBuy: () => void; buying: boolean }) {
  return (
    <li className="flex list-none flex-col gap-4 rounded-card border border-line bg-card p-6">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xl">{plan.name}</h3>
        {current ? <Badge tone="ok">Your plan</Badge> : null}
      </div>
      <p className="flex items-baseline gap-1.5">
        <Price paise={plan.pricePaise} size="total" /> <span className="text-sm text-fg-3">/ {plan.durationDays} days</span>
      </p>
      <ul className="flex flex-col gap-2 text-sm text-fg-2">
        {benefitLines(plan).map((l) => (
          <li key={l} className="flex gap-2">
            <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" />
            {l}
          </li>
        ))}
      </ul>
      {plan.terms ? <p className="whitespace-pre-line border-t border-line pt-3 text-[13px] text-fg-3">{plan.terms}</p> : null}
      <Button className="mt-auto" size="lg" onClick={onBuy} loading={buying} disabled={blockedReason !== null} aria-describedby={blockedReason ? 'membership-blocked' : undefined}>
        {current ? 'Your active plan' : `Buy for ${formatINR(plan.pricePaise)}`}
      </Button>
    </li>
  );
}

export default function MembershipPage() {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const returningIntent = params.get('payment');
  const plans = useQuery({ queryKey: ['memberships', 'plans'], queryFn: fetchPlans, staleTime: 5 * 60_000 });
  const mine = useQuery({ queryKey: MEMBERSHIP_KEY, queryFn: fetchMyMemberships, enabled: isAuthenticated });
  const { launch, opening, error: launchError } = usePaymentLauncher();
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<unknown>(null);
  const [login, setLogin] = useState<string | null>(null);
  const attempt = useRef<{ planId: string; key: string } | null>(null);

  const active = mine.data?.current?.status === 'ACTIVE' ? mine.data.current : null;
  const blockedReason = active ? `You already have an active membership${active.endsAt ? ` until ${formatDate(active.endsAt)}` : ''}. You can buy a new plan after it ends.` : null;
  const confirming = !!returningIntent && isAuthenticated && !active;
  usePolling(() => mine.refetch(), 3000, { enabled: confirming, pauseWhenHidden: true });

  const buy = async (planId: string) => {
    if (!isAuthenticated) {
      setLogin(planId);
      return;
    }
    if (buyingId || blockedReason) return;
    setBuyError(null);
    setBuyingId(planId);
    if (!attempt.current || attempt.current.planId !== planId) attempt.current = { planId, key: newIdempotencyKey() };
    try {
      const res = await purchaseMembership(planId, attempt.current.key);
      const payment = normalizePayment(res.payment);
      if (!payment) throw new ApiError({ code: 'INVALID_RESPONSE', status: 200, message: 'The payment could not be started. Please try again.' });
      attempt.current = null;
      void qc.invalidateQueries({ queryKey: MEMBERSHIP_KEY });
      await launch(payment, { kind: 'membership', description: 'Thali Plus membership' });
    } catch (e) {
      setBuyError(e);
    } finally {
      setBuyingId(null);
    }
  };

  const perPeriod = active?.plan.benefits.freeDeliveriesPerPeriod ?? 0;
  return (
    <PageContainer>
      <PageHeader
        size="page"
        title={
          <>
            Thali <Accent>Plus</Accent>
          </>
        }
        documentTitle="Thali Plus"
        description="Prepaid plans with free deliveries and extra savings. No auto-renewal — buy again when it ends."
      />
      <div className="flex flex-col gap-7">
        {confirming ? (
          <InfoNotice tone="info" icon="clock" role="status">
            <span className="flex flex-wrap items-center gap-2">
              <Spinner size={16} label="Confirming" /> Confirming your membership payment… this updates automatically.
              <Button variant="link" size="sm" onClick={() => setParams({}, { replace: true })}>
                Dismiss
              </Button>
            </span>
          </InfoNotice>
        ) : null}

        {isAuthenticated ? (
          mine.isPending ? (
            <Skeleton className="h-36 w-full rounded-card" />
          ) : mine.isError ? (
            <ErrorState compact error={mine.error} title="Couldn't load your membership" onRetry={() => void mine.refetch()} />
          ) : active ? (
            <section aria-label="Your membership" className="flex flex-col gap-4 rounded-card border border-line bg-acc-soft p-6">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-xl">{active.plan.name}</h2>
                <StatusPill kind="membership" status={active.status} />
                {active.endsAt ? <span className="text-sm text-fg-3">Valid till {formatDate(active.endsAt)}</span> : null}
              </div>
              {perPeriod > 0 ? (
                <ProgressBar
                  value={active.freeDeliveriesRemaining}
                  max={perPeriod}
                  label="Free deliveries left"
                  tone="ok"
                  left={`${active.freeDeliveriesRemaining} of ${perPeriod} free deliveries left this plan period`}
                />
              ) : null}
              <ul className="flex flex-col gap-1 text-sm text-fg-2">
                {benefitLines(active.plan).map((l) => (
                  <li key={l} className="flex gap-2">
                    <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" />
                    {l}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-3">Turn on “Use Thali Plus benefits” at checkout. Eligibility is checked on every order.</p>
            </section>
          ) : (
            <p className="text-sm text-fg-2">You don&rsquo;t have an active membership.</p>
          )
        ) : null}

        <section aria-labelledby="plans-h" className="flex flex-col gap-3">
          <h2 id="plans-h" className="text-xl">
            Plans
          </h2>
          <InlineError error={buyError ?? launchError} />
          {blockedReason ? (
            <p id="membership-blocked" className="text-sm text-info">
              {blockedReason}
            </p>
          ) : null}
          {plans.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-4">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : plans.isError ? (
            <ErrorState error={plans.error} title="Couldn't load plans" onRetry={() => void plans.refetch()} />
          ) : plans.data.filter((p) => p.active !== false).length === 0 ? (
            <EmptyState icon="star" title="No plans available right now" description="Check back soon." />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-4">
              {plans.data
                .filter((p) => p.active !== false)
                .map((p) => (
                  <PlanCard
                    key={p.id}
                    plan={p}
                    current={active?.planId === p.id}
                    blockedReason={blockedReason}
                    buying={buyingId === p.id || (opening && attempt.current?.planId === p.id)}
                    onBuy={() => void buy(p.id)}
                  />
                ))}
            </ul>
          )}
          {!isAuthenticated ? <p className="text-sm text-fg-3">Sign in to buy — your membership is linked to your phone number.</p> : null}
        </section>

        {isAuthenticated && mine.data?.history.length ? (
          <section aria-labelledby="history-h" className="flex flex-col gap-3">
            <h2 id="history-h" className="text-xl">
              History
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
              {mine.data.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span>
                    <span className="font-medium">{h.plan.name}</span>
                    <span className="text-fg-3">
                      {h.startsAt ? ` · ${formatDate(h.startsAt)}` : ''}
                      {h.endsAt ? ` – ${formatDate(h.endsAt)}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2.5">
                    <Price paise={h.plan.pricePaise} size="sm" />
                    <StatusPill kind="membership" status={h.status} density="dense" />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <LoginDialog open={login !== null} onClose={() => setLogin(null)} reason="Sign in to buy Thali Plus." onSignedIn={() => setLogin(null)} />
    </PageContainer>
  );
}
