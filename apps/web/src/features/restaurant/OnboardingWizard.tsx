/**
 * Restaurant onboarding wizard (PRD R-1/R-2, LLD 4.6).
 *   /restaurant/onboarding             create a new restaurant (step 1; grants the owner role)
 *   /restaurant/onboarding/:id?step=x  edit an existing restaurant, any step
 * Every step saves to the server (PATCH / PUT / presigned upload) before moving on, so progress survives a
 * reload. The email-verification link redirects back here with `?emailVerified=1|0&reason=...`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { AccentWord, ButtonLink, Icon, PageHeader, QueryState, StatusPill } from '../../components/ui';
import { cn } from '../../lib/cn';
import { cacheRestaurant, keys, useRestaurantById, type OwnerRestaurant } from './api';
import { StatusBanner } from './StatusBanner';
import { BusinessStep } from './steps/BusinessStep';
import { DocumentsStep } from './steps/DocumentsStep';
import { HoursStep } from './steps/HoursStep';
import { LocationStep } from './steps/LocationStep';
import { MediaStep } from './steps/MediaStep';
import { ReviewStep } from './steps/ReviewStep';
import { SettlementStep } from './steps/SettlementStep';
import type { StepProps } from './steps/StepFrame';
import { firstIncompleteStep, isStepId, stepDone, WIZARD_STEP_META, type StepId } from './wizard';

export const WIZARD_STEPS = [
  { ...WIZARD_STEP_META[0], Component: BusinessStep },
  { ...WIZARD_STEP_META[1], Component: LocationStep },
  { ...WIZARD_STEP_META[2], Component: HoursStep },
  { ...WIZARD_STEP_META[3], Component: MediaStep },
  { ...WIZARD_STEP_META[4], Component: DocumentsStep },
  { ...WIZARD_STEP_META[5], Component: SettlementStep },
  { ...WIZARD_STEP_META[6], Component: ReviewStep },
] as const;

export { firstIncompleteStep };

const VERIFY_REASONS: Record<string, string> = {
  invalid: 'This verification link is not valid. Request a new one from your dashboard.',
  expired: 'This verification link has expired. Request a new one from your dashboard.',
  already_verified: 'This email address was already verified.',
};

function EmailVerifiedNotice({ ok, reason }: { ok: boolean; reason: string | null }) {
  const alreadyDone = reason === 'already_verified';
  const success = ok || alreadyDone;
  return (
    <div role={success ? 'status' : 'alert'} className={cn('mb-5 flex items-start gap-3 rounded-field border border-line px-4 py-3.5', success ? 'bg-ok-bg' : 'bg-bad-bg')}>
        <Icon name={success ? 'check' : 'alert'} size={20} className={cn('mt-0.5 shrink-0', success ? 'text-ok' : 'text-bad')} />
        <div>
          <h2 className="font-sans text-[14.5px] font-medium tracking-normal text-fg">{success ? 'Business email verified' : "We couldn't verify your email"}</h2>
          <p className="mt-0.5 text-[13px] text-fg-3">
            {success
              ? 'Thanks. Our team will now review your restaurant. You can follow its status on your dashboard.'
              : (reason && VERIFY_REASONS[reason]) || 'Request a new verification email from your dashboard.'}
          </p>
        </div>
    </div>
  );
}

export default function OnboardingWizard() {
  const { restaurantId } = useParams<{ restaurantId?: string }>();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const query = useRestaurantById(restaurantId);
  const verifiedParam = sp.get('emailVerified');
  const bodyRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const stepParam = sp.get('step');
  const resolveStep = (r: OwnerRestaurant | undefined): StepId => {
    if (!restaurantId) return 'business';
    if (isStepId(stepParam)) return stepParam;
    return r ? firstIncompleteStep(r) : 'business';
  };
  const current = resolveStep(query.data);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    bodyRef.current?.focus();
  }, [current]);

  // landing from the email link without a restaurant id: just report the outcome
  if (!restaurantId && verifiedParam !== null) {
    return (
      <>
        <PageHeader title="Email verification" />
        <EmailVerifiedNotice ok={verifiedParam === '1'} reason={sp.get('reason')} />
        <ButtonLink to="/restaurant">Go to dashboard</ButtonLink>
      </>
    );
  }

  const go = (id: StepId) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    n.set('step', id);
    n.delete('emailVerified');
    n.delete('reason');
    return n;
  });
  const idx = WIZARD_STEPS.findIndex((s) => s.id === current);

  const render = (restaurant: OwnerRestaurant | undefined) => {
    const Step = WIZARD_STEPS[idx]!.Component;
    const props: StepProps = {
      restaurant,
      onSaved: (r) => {
        cacheRestaurant(qc, r);
        void qc.invalidateQueries({ queryKey: keys.restaurants });
      },
      next: () => go(WIZARD_STEPS[Math.min(idx + 1, WIZARD_STEPS.length - 1)]!.id),
      back: () => go(WIZARD_STEPS[Math.max(idx - 1, 0)]!.id),
    };
    return (
      <>
        {verifiedParam !== null ? <EmailVerifiedNotice ok={verifiedParam === '1'} reason={sp.get('reason')} /> : null}
        {restaurant ? <StatusBanner restaurant={restaurant} hideDraft editHref={`/restaurant/onboarding/${restaurant.id}`} className="mb-5" /> : null}
        <nav aria-label="Onboarding steps" className="mb-5">
          <p className="sr-only" aria-live="polite">
            Step {idx + 1} of {WIZARD_STEPS.length}: {WIZARD_STEPS[idx]!.label}
          </p>
          <ol className="-mx-1 grid auto-cols-[minmax(96px,1fr)] grid-flow-col gap-1.5 overflow-x-auto px-1 pb-1">
            {WIZARD_STEPS.map((s, i) => {
              const enabled = Boolean(restaurant) || i === 0;
              const done = stepDone(restaurant, s.id);
              const isCurrent = i === idx;
              const bar = isCurrent ? 'bg-acc' : done ? 'bg-ok' : 'bg-fill';
              const inner = (
                <>
                  <span aria-hidden="true" className={cn('h-1 w-full rounded-full', bar)} />
                  <span className={cn('flex items-center gap-1.5 text-[13px]', isCurrent ? 'font-semibold text-fg' : done ? 'text-fg-2' : 'text-fg-3')}>
                    {done && !isCurrent ? <Icon name="check" size={13} className="text-ok" /> : <span aria-hidden="true" className="font-mono text-[11px]">{String(i + 1).padStart(2, '0')}</span>}
                    {s.label}
                    {done ? <span className="sr-only"> (complete)</span> : null}
                  </span>
                </>
              );
              const cls = cn('flex min-h-touch flex-col justify-center gap-2 rounded-item px-1 py-1', enabled ? 'hover:bg-fill' : 'opacity-50');
              return (
                <li key={s.id}>
                  {enabled ? (
                    <Link to={`?step=${s.id}`} aria-current={isCurrent ? 'step' : undefined} className={cls}>
                      {inner}
                    </Link>
                  ) : (
                    <span className={cls} aria-disabled="true">
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div ref={bodyRef} tabIndex={-1} className="outline-none">
          <section className="rounded-card border border-line bg-card p-5 sm:p-7">
            <Step key={`${restaurant?.id ?? 'new'}-${current}`} {...props} />
          </section>
        </div>
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={restaurantId ? (query.data ? <>Set up <AccentWord>{query.data.name}</AccentWord></> : 'Restaurant setup') : <>Register your <AccentWord>restaurant</AccentWord></>}
        documentTitle={restaurantId ? 'Restaurant setup' : 'Register your restaurant'}
        description={restaurantId ? undefined : 'A few steps and your kitchen is ready for review.'}
        status={query.data ? <StatusPill kind="restaurant" status={query.data.status} /> : undefined}
        back={restaurantId ? { to: '/restaurant', label: 'Dashboard' } : undefined}
      />
      {restaurantId ? (
        <QueryState query={query} loadingLabel="Loading your restaurant…">
          {(r) => render(r)}
        </QueryState>
      ) : (
        render(undefined)
      )}
    </>
  );
}
