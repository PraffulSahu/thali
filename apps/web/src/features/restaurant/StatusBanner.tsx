/**
 * Restaurant status banner (design-spec 20-11, §7.3 "status banner always on top of main"). One per state:
 *   DRAFT                 "Finish setting up your restaurant" · step N of 7 · Continue setup
 *   VERIFICATION_PENDING  "Verify your business email" · Resend email (server 60 s cooldown, rate limit) · Change email
 *   APPROVAL_PENDING      "Our team is reviewing your restaurant" · View submission (wizard review step)
 *   REJECTED              "Your application needs changes" · reason · Edit and resubmit (review step)
 *   SUSPENDED             "Restaurant suspended" · reason · Contact support (/support?new=1)
 *   APPROVED + paused     "Not accepting orders until 3:30 PM" · Resume now
 * Hidden when approved and taking orders.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, ButtonLink, InlineError, StatusBanner as Banner, useToast } from '../../components/ui';
import { useCountdown } from '../../components/ui/Countdown';
import { ApiError } from '../../lib/errors';
import { formatDuration, formatTime } from '../../lib/format';
import { restaurantApi, type OwnerRestaurant } from './api';
import { usePauseActions, usePaused } from './PauseControl';
import { firstIncompleteStep, WIZARD_STEP_META } from './wizard';

const RESEND_COOLDOWN_MS = 60_000;

export interface StatusBannerProps {
  restaurant: OwnerRestaurant;
  /** Hide the "finish onboarding" banner (used inside the wizard itself). */
  hideDraft?: boolean;
  /** Link target for editing details; defaults to the wizard for this restaurant. */
  editHref?: string;
  className?: string;
}

export function StatusBanner({ restaurant: r, hideDraft, editHref, className }: StatusBannerProps) {
  const edit = editHref ?? `/restaurant/onboarding/${r.id}`;
  switch (r.status) {
    case 'DRAFT': {
      if (hideDraft) return null;
      const step = firstIncompleteStep(r);
      const idx = WIZARD_STEP_META.findIndex((s) => s.id === step);
      return (
        <Banner
          tone="neutral"
          className={className}
          title="Finish setting up your restaurant"
          action={<ButtonLink to={edit} variant="outline">Continue setup</ButtonLink>}
        >
          You&rsquo;re on step {idx + 1} of {WIZARD_STEP_META.length} &mdash; {WIZARD_STEP_META[idx]!.label.toLowerCase()}. {r.name} isn&rsquo;t visible to customers yet.
        </Banner>
      );
    }
    case 'VERIFICATION_PENDING':
      return <VerificationPending restaurant={r} editHref={edit} className={className} />;
    case 'APPROVAL_PENDING':
      return (
        <Banner
          tone="info"
          className={className}
          title="Our team is reviewing your restaurant"
          action={<ButtonLink to={`${edit}?step=review`} variant="outline">View submission</ButtonLink>}
        >
          Your business email is verified. You&rsquo;ll be visible to customers once approved &mdash; keep building your menu meanwhile.
        </Banner>
      );
    case 'REJECTED':
      return (
        <Banner
          tone="bad"
          className={className}
          title="Your application needs changes"
          action={<ButtonLink to={`${edit}?step=review`} variant="outline">Edit and resubmit</ButtonLink>}
        >
          Reason: {r.statusReason?.trim() || 'No reason was recorded.'} Fix it, then resubmit &mdash; nothing else needs re-entering.
        </Banner>
      );
    case 'SUSPENDED':
      return (
        <Banner
          tone="bad"
          className={className}
          title="Restaurant suspended"
          action={<ButtonLink to="/support?new=1" variant="outline">Contact support</ButtonLink>}
        >
          Reason: {r.statusReason?.trim() || 'No reason was recorded.'} {r.name} is hidden from customers. Contact support to resolve.
        </Banner>
      );
    case 'APPROVED':
      return <PausedBanner restaurant={r} className={className} />;
    default:
      return null;
  }
}

function VerificationPending({ restaurant: r, editHref, className }: { restaurant: OwnerRestaurant; editHref: string; className?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [until, setUntil] = useState<number | null>(null);
  const sentAt = r.emailVerification?.sentAt ? Date.parse(r.emailVerification.sentAt) : null;
  const serverUntil = sentAt && !Number.isNaN(sentAt) ? sentAt + RESEND_COOLDOWN_MS : null;
  const cooldownEnds = Math.max(until ?? 0, serverUntil ?? 0) || null;
  const left = useCountdown(cooldownEnds);
  const cooling = left !== null && left > 0;

  const resend = useMutation({
    mutationFn: () => restaurantApi.resendVerification(r.id),
    onSuccess: (res) => {
      const at = Date.parse(res.sentAt);
      setUntil((Number.isNaN(at) ? Date.now() : at) + RESEND_COOLDOWN_MS);
      toast({ title: 'Verification email sent', description: `Check ${r.businessEmail ?? 'your inbox'}.`, tone: 'success' });
      void qc.invalidateQueries({ queryKey: ['owner', 'restaurant', r.id] });
      void qc.invalidateQueries({ queryKey: ['owner', 'restaurants'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'RATE_LIMITED') setUntil(Date.now() + (e.retryAfterSec ?? 60) * 1000);
    },
  });

  return (
    <Banner
      tone="warn"
      className={className}
      title="Verify your business email"
      action={
        <Button variant="outline" onClick={() => resend.mutate()} loading={resend.isPending} disabled={cooling}>
          {cooling ? `Resend in ${formatDuration(left ?? 0)}` : 'Resend email'}
        </Button>
      }
    >
      We sent a link to <strong className="font-medium text-fg-2">{r.businessEmail ?? 'your business email'}</strong>. Review starts once it&rsquo;s verified.{' '}
      <Link to={`${editHref}?step=business`} className="font-medium text-fg-2 underline underline-offset-2 hover:text-fg">
        Change email
      </Link>
      <InlineError error={resend.error} className="mt-1" />
    </Banner>
  );
}

function PausedBanner({ restaurant: r, className }: { restaurant: OwnerRestaurant; className?: string }) {
  const paused = usePaused(r);
  const { resume } = usePauseActions(r);
  if (!paused) return null;
  return (
    <Banner
      tone="warn"
      className={className}
      title={`Not accepting orders until ${formatTime(r.pausedUntil)}`}
      action={
        <Button variant="outline" onClick={() => resume.mutate()} loading={resume.isPending}>
          Resume now
        </Button>
      }
    >
      Customers see &ldquo;Temporarily not accepting orders&rdquo;.
    </Banner>
  );
}
