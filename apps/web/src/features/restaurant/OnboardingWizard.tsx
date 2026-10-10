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
import { ButtonLink, Card, Icon, PageHeader, QueryState, StatusPill } from '../../components/ui';
import { cn } from '../../lib/cn';
import { cacheRestaurant, keys, missingForSubmit, useRestaurantById, type OwnerRestaurant } from './api';
import { StatusBanner } from './StatusBanner';
import { BusinessStep } from './steps/BusinessStep';
import { DocumentsStep } from './steps/DocumentsStep';
import { HoursStep } from './steps/HoursStep';
import { LocationStep } from './steps/LocationStep';
import { MediaStep } from './steps/MediaStep';
import { ReviewStep } from './steps/ReviewStep';
import { SettlementStep } from './steps/SettlementStep';
import type { StepProps } from './steps/StepFrame';

export const WIZARD_STEPS = [
  { id: 'business', label: 'Business', Component: BusinessStep },
  { id: 'location', label: 'Location', Component: LocationStep },
  { id: 'hours', label: 'Hours', Component: HoursStep },
  { id: 'media', label: 'Photos', Component: MediaStep },
  { id: 'documents', label: 'Documents', Component: DocumentsStep },
  { id: 'settlement', label: 'Settlement', Component: SettlementStep },
  { id: 'review', label: 'Review', Component: ReviewStep },
] as const;
type StepId = (typeof WIZARD_STEPS)[number]['id'];

function isStepId(s: string | null): s is StepId {
  return WIZARD_STEPS.some((x) => x.id === s);
}

/** First step with something missing, else the review step. */
export function firstIncompleteStep(r: OwnerRestaurant): StepId {
  const missing = missingForSubmit(r);
  const first = WIZARD_STEPS.find((s) => missing.some((m) => m.step === s.id));
  return first?.id ?? 'review';
}

function stepDone(r: OwnerRestaurant | undefined, id: StepId): boolean {
  if (!r) return false;
  if (id === 'review') return r.status !== 'DRAFT' && r.status !== 'REJECTED';
  if (id === 'media') return Boolean(r.images.cover || r.images.logo);
  return !missingForSubmit(r).some((m) => m.step === id);
}

const VERIFY_REASONS: Record<string, string> = {
  invalid: 'This verification link is not valid. Request a new one from your dashboard.',
  expired: 'This verification link has expired. Request a new one from your dashboard.',
  already_verified: 'This email address was already verified.',
};

function EmailVerifiedNotice({ ok, reason }: { ok: boolean; reason: string | null }) {
  const alreadyDone = reason === 'already_verified';
  const success = ok || alreadyDone;
  return (
    <Card tone={success ? 'brand' : 'danger'} className="mb-5">
      <div role={success ? 'status' : 'alert'} className="flex items-start gap-3">
        <Icon name={success ? 'check' : 'alert'} size={22} className="mt-0.5 shrink-0" />
        <div>
          <h2 className="text-base font-semibold text-slate-900">{success ? 'Business email verified' : "We couldn't verify your email"}</h2>
          <p className="mt-1 text-[0.9375rem] text-slate-700">
            {success
              ? 'Thanks. Our team will now review your restaurant. You can follow its status on your dashboard.'
              : (reason && VERIFY_REASONS[reason]) || 'Request a new verification email from your dashboard.'}
          </p>
        </div>
      </div>
    </Card>
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
        {restaurant ? <StatusBanner restaurant={restaurant} hideDraft editHref={`/restaurant/onboarding/${restaurant.id}`} /> : null}
        <nav aria-label="Onboarding steps" className="mb-5">
          <p className="mb-2 text-sm text-slate-600" aria-live="polite">
            Step {idx + 1} of {WIZARD_STEPS.length}: {WIZARD_STEPS[idx]!.label}
          </p>
          <ol className="flex gap-1.5 overflow-x-auto pb-1">
            {WIZARD_STEPS.map((s, i) => {
              const enabled = Boolean(restaurant) || i === 0;
              const done = stepDone(restaurant, s.id);
              const isCurrent = i === idx;
              const cls = cn(
                'flex min-h-touch items-center gap-1.5 whitespace-nowrap rounded-pill px-3 text-sm font-medium ring-1 ring-inset',
                isCurrent ? 'bg-brand-600 text-white ring-brand-600' : done ? 'bg-success-50 text-success-800 ring-success-100' : 'bg-surface text-slate-700 ring-slate-300',
                !enabled && 'opacity-50',
              );
              return (
                <li key={s.id}>
                  {enabled ? (
                    <Link to={`?step=${s.id}`} aria-current={isCurrent ? 'step' : undefined} className={cls}>
                      {done && !isCurrent ? <Icon name="check" size={14} /> : <span aria-hidden="true">{i + 1}</span>}
                      {s.label}
                      {done ? <span className="sr-only"> (complete)</span> : null}
                    </Link>
                  ) : (
                    <span className={cls} aria-disabled="true">
                      <span aria-hidden="true">{i + 1}</span>
                      {s.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div ref={bodyRef} tabIndex={-1} className="outline-none">
          <Card padding="lg">
            <Step key={`${restaurant?.id ?? 'new'}-${current}`} {...props} />
          </Card>
        </div>
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={restaurantId ? 'Restaurant setup' : 'Register your restaurant'}
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
