/**
 * Membership (PRD C-13): plans with transparent terms, my status/expiry, purchase history. Buying creates a
 * PENDING_PAYMENT membership + payment intent (`POST /memberships/purchase`, Idempotency-Key per attempt) and
 * goes through the same payment step as checkout. Activation is server-side (payment.captured); on return
 * (`?payment=<intentId>`) we poll until the server reports it ACTIVE. Benefits are enforced by the server.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  InlineError,
  PageHeader,
  Price,
  QueryState,
  Skeleton,
  SkeletonList,
  Spinner,
  StatusPill,
} from '../../components/ui';
import { usePolling } from '../../hooks/usePolling';
import { newIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useAuth } from '../../lib/auth';
import { ApiError } from '../../lib/errors';
import { formatBps, formatDate, formatINR } from '../../lib/format';
import { fetchMyMemberships, fetchPlans, MEMBERSHIP_KEY, normalizePayment, purchaseMembership, type MembershipPlan } from './api';
import { LoginDialog } from './LoginDialog';
import { usePaymentLauncher } from './PaymentStep';

export function benefitLines(p: MembershipPlan): string[] {
  const b = p.benefits ?? {};
  const out: string[] = [];
  if (b.freeDeliveriesPerPeriod) {
    out.push(
      `${b.freeDeliveriesPerPeriod} free deliveries${b.freeDeliveryMinOrderPaise ? ` on restaurant orders above ${formatINR(b.freeDeliveryMinOrderPaise)}` : ''}`,
    );
  }
  if (b.extraDiscountBps) out.push(`Extra ${formatBps(b.extraDiscountBps)} off${b.extraDiscountCapPaise ? ` (up to ${formatINR(b.extraDiscountCapPaise)} per order)` : ''}`);
  out.push(`Valid for ${p.durationDays} days from payment · prepaid, no auto-renewal`);
  return out;
}

function PlanCard({ plan, current, onBuy, buying }: { plan: MembershipPlan; current: boolean; onBuy: () => void; buying: boolean }) {
  return (
    <Card as="li" className="flex list-none flex-col">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
        {current ? <Badge tone="success">Your plan</Badge> : null}
      </div>
      <p className="my-2">
        <Price paise={plan.pricePaise} size="lg" /> <span className="text-sm text-slate-600">/ {plan.durationDays} days</span>
      </p>
      <ul className="mb-3 space-y-1 text-sm text-slate-700">
        {benefitLines(plan).map((l) => (
          <li key={l} className="flex gap-2">
            <Icon name="check" size={16} className="mt-0.5 shrink-0 text-success-700" />
            {l}
          </li>
        ))}
      </ul>
      {plan.terms ? (
        <details className="mb-3 text-sm text-slate-600">
          <summary className="min-h-touch cursor-pointer py-2 font-medium text-slate-800">Terms</summary>
          <p className="whitespace-pre-line">{plan.terms}</p>
        </details>
      ) : null}
      <Button className="mt-auto" onClick={onBuy} loading={buying} disabled={current}>
        {current ? 'Active' : `Buy for ${formatINR(plan.pricePaise)}`}
      </Button>
    </Card>
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

  const active = mine.data?.active && mine.data.active.status === 'ACTIVE' ? mine.data.active : null;
  const confirming = !!returningIntent && isAuthenticated && !active;
  usePolling(() => mine.refetch(), 3000, { enabled: confirming, pauseWhenHidden: true });

  const buy = async (planId: string) => {
    if (!isAuthenticated) {
      setLogin(planId);
      return;
    }
    if (buyingId) return;
    setBuyError(null);
    setBuyingId(planId);
    if (!attempt.current || attempt.current.planId !== planId) attempt.current = { planId, key: newIdempotencyKey() };
    try {
      const res = await purchaseMembership(planId, attempt.current.key);
      const payment = normalizePayment(res.payment ?? res.paymentIntent ?? res);
      if (!payment) throw new ApiError({ code: 'INVALID_RESPONSE', status: 200, message: 'The payment could not be started. Please try again.' });
      attempt.current = null;
      void qc.invalidateQueries({ queryKey: MEMBERSHIP_KEY });
      await launch(payment, { kind: 'membership', description: 'Thali membership' });
    } catch (e) {
      setBuyError(e);
    } finally {
      setBuyingId(null);
    }
  };

  return (
    <>
      <PageHeader title="Thali membership" description="Prepaid plans with free deliveries and extra savings. No auto-renewal — buy again when it ends." />
      <div className="space-y-6">
        {isAuthenticated ? (
          <Card as="section" aria-label="My membership">
            <CardHeader title="My membership" />
            {confirming ? (
              <p role="status" className="mb-3 flex items-center gap-2 rounded-control bg-info-50 px-3 py-2 text-sm text-info-800">
                <Spinner size={16} label="Confirming" /> Confirming your membership payment… this updates automatically.
                <Button variant="link" size="sm" onClick={() => setParams({}, { replace: true })}>
                  Dismiss
                </Button>
              </p>
            ) : null}
            <QueryState query={mine} loading={<Skeleton className="h-16 w-full" />}>
              {(m) => (
                <>
                  {active ? (
                    <div className="space-y-1">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                        {active.planSnapshot?.name ?? 'Membership'} <StatusPill kind="membership" status={active.status} />
                      </p>
                      {active.endsAt ? <p className="text-sm text-slate-700">Valid until {formatDate(active.endsAt)}</p> : null}
                      {active.freeDeliveriesUsed != null && active.planSnapshot?.benefits?.freeDeliveriesPerPeriod ? (
                        <p className="text-sm text-slate-700">
                          Free deliveries used: {active.freeDeliveriesUsed} of {active.planSnapshot.benefits.freeDeliveriesPerPeriod}
                        </p>
                      ) : null}
                      <p className="text-xs text-slate-600">Turn on “Use membership benefits” at checkout. Eligibility is checked on every order.</p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-700">You don&rsquo;t have an active membership.</p>
                  )}
                  {m.history.length ? (
                    <div className="mt-4">
                      <h3 className="mb-1 text-sm font-semibold text-slate-900">History</h3>
                      <ul className="divide-y divide-slate-100 text-sm">
                        {m.history.map((h) => (
                          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                            <span>
                              {h.planSnapshot?.name ?? 'Membership'}
                              {h.startsAt ? <span className="text-slate-600"> · {formatDate(h.startsAt)}</span> : null}
                              {h.endsAt ? <span className="text-slate-600"> – {formatDate(h.endsAt)}</span> : null}
                            </span>
                            <span className="flex items-center gap-2">
                              {h.planSnapshot?.pricePaise != null ? <Price paise={h.planSnapshot.pricePaise} size="sm" /> : null}
                              <StatusPill kind="membership" status={h.status} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </QueryState>
          </Card>
        ) : null}

        <section aria-labelledby="plans-h">
          <h2 id="plans-h" className="mb-3 text-lg font-semibold text-slate-900">
            Plans
          </h2>
          <InlineError error={buyError ?? launchError} className="mb-3" />
          <QueryState
            query={plans}
            loading={<SkeletonList count={2} />}
            isEmpty={(l) => l.length === 0}
            empty={{ icon: 'star', title: 'No plans available right now', description: 'Check back soon.' }}
          >
            {(list) => (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list
                  .filter((p) => p.active !== false)
                  .map((p) => (
                    <PlanCard key={p.id} plan={p} current={active?.planId === p.id} buying={buyingId === p.id || (opening && attempt.current?.planId === p.id)} onBuy={() => void buy(p.id)} />
                  ))}
              </ul>
            )}
          </QueryState>
        </section>
        {!isAuthenticated ? <EmptyState compact icon="user" title="Sign in to buy a membership" description="Your membership is linked to your phone number." /> : null}
      </div>
      <LoginDialog
        open={login !== null}
        onClose={() => setLogin(null)}
        reason="Sign in to buy a membership."
        onSignedIn={() => setLogin(null)}
      />
    </>
  );
}
