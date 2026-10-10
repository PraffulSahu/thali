/**
 * Onboarding / store status banner (PRD R-2, LLD 4.6). One banner per state:
 *   DRAFT                 finish onboarding (link to the wizard)
 *   VERIFICATION_PENDING  check the business email; resend button with the server's 60 s cooldown
 *   APPROVAL_PENDING      email verified, waiting for admin review
 *   REJECTED              reason + edit + resubmit
 *   SUSPENDED             reason, not taking orders
 *   APPROVED              nothing, except a "paused until" notice with a Resume button
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, ButtonLink, InlineError, Icon, useToast } from '../../components/ui';
import { useCountdown } from '../../components/ui/Countdown';
import type { IconName } from '../../components/ui/Icon';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/errors';
import { formatDuration, formatTime } from '../../lib/format';
import { cacheRestaurant, restaurantApi, type OwnerRestaurant } from './api';

const RESEND_COOLDOWN_MS = 60_000;

type Tone = 'info' | 'warn' | 'danger';
const toneClass: Record<Tone, string> = {
  info: 'border-info-100 bg-info-50 text-info-800',
  warn: 'border-warn-100 bg-warn-50 text-warn-800',
  danger: 'border-danger-100 bg-danger-50 text-danger-800',
};

function Banner({ tone, icon, title, children, actions, alert }: { tone: Tone; icon: IconName; title: ReactNode; children?: ReactNode; actions?: ReactNode; alert?: boolean }) {
  return (
    <section
      role={alert ? 'alert' : 'status'}
      aria-label="Restaurant status"
      className={cn('mb-5 flex flex-col gap-3 rounded-card border p-4 sm:flex-row sm:items-start', toneClass[tone])}
    >
      <Icon name={icon} size={22} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {children ? <div className="mt-1 text-[0.9375rem] [&_p+p]:mt-1">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
    </section>
  );
}

export interface StatusBannerProps {
  restaurant: OwnerRestaurant;
  /** Hide the "finish onboarding" banner (used inside the wizard itself). */
  hideDraft?: boolean;
  /** Link target for editing details; defaults to the wizard for this restaurant. */
  editHref?: string;
}

export function StatusBanner({ restaurant: r, hideDraft, editHref }: StatusBannerProps) {
  const edit = editHref ?? `/restaurant/onboarding/${r.id}`;
  switch (r.status) {
    case 'DRAFT':
      if (hideDraft) return null;
      return (
        <Banner
          tone="info"
          icon="info"
          title="Finish setting up your restaurant"
          actions={<ButtonLink to={edit} size="sm">Continue setup</ButtonLink>}
        >
          <p>{r.name} isn&rsquo;t visible to customers yet. Complete the onboarding steps and submit it for review.</p>
        </Banner>
      );
    case 'VERIFICATION_PENDING':
      return <VerificationPending restaurant={r} editHref={edit} />;
    case 'APPROVAL_PENDING':
      return (
        <Banner tone="info" icon="clock" title="Awaiting approval">
          <p>Your business email is verified. Our team is reviewing {r.name}. You can keep preparing your menu while you wait.</p>
          <p>You&rsquo;ll be able to take orders as soon as the restaurant is approved.</p>
        </Banner>
      );
    case 'REJECTED':
      return <Rejected restaurant={r} editHref={edit} />;
    case 'SUSPENDED':
      return (
        <Banner tone="danger" icon="alert" alert title="Your restaurant is suspended">
          <p>
            <strong>Reason:</strong> {r.statusReason?.trim() || 'No reason was recorded.'}
          </p>
          <p>{r.name} is hidden from customers and can&rsquo;t receive new orders. Contact Thali support if you think this is a mistake.</p>
        </Banner>
      );
    case 'APPROVED':
      return <PausedNotice restaurant={r} />;
    default:
      return null;
  }
}

function VerificationPending({ restaurant: r, editHref }: { restaurant: OwnerRestaurant; editHref: string }) {
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
      if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
        setUntil(Date.now() + (e.retryAfterSec ?? 60) * 1000);
      }
    },
  });

  return (
    <Banner
      tone="warn"
      icon="alert"
      title="Verify your business email"
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={() => resend.mutate()} loading={resend.isPending} disabled={cooling}>
            {cooling ? `Resend in ${formatDuration(left ?? 0)}` : 'Resend verification email'}
          </Button>
          <Link to={editHref + '?step=business'} className="text-sm font-semibold underline-offset-4 hover:underline">
            Change email
          </Link>
        </>
      }
    >
      <p>
        We sent a verification link to <strong>{r.businessEmail ?? 'your business email'}</strong>. Open it to continue. Review by our team starts after the
        email is verified.
      </p>
      <InlineError error={resend.error} />
    </Banner>
  );
}

function Rejected({ restaurant: r, editHref }: { restaurant: OwnerRestaurant; editHref: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const resubmit = useMutation({
    mutationFn: () => restaurantApi.submit(r.id),
    onSuccess: (updated) => {
      cacheRestaurant(qc, updated);
      toast({ title: 'Resubmitted for review', tone: 'success' });
    },
  });
  return (
    <Banner
      tone="danger"
      icon="alert"
      alert
      title="Your restaurant wasn't approved"
      actions={
        <>
          <ButtonLink to={editHref} variant="secondary" size="sm">Edit details</ButtonLink>
          <Button size="sm" onClick={() => resubmit.mutate()} loading={resubmit.isPending}>Resubmit for review</Button>
        </>
      }
    >
      <p>
        <strong>Reason:</strong> {r.statusReason?.trim() || 'No reason was recorded.'}
      </p>
      <p>Fix what&rsquo;s mentioned, then resubmit. Nothing else needs to be re-entered.</p>
      {resubmit.isError ? <InlineError error={resubmit.error} /> : null}
    </Banner>
  );
}

function PausedNotice({ restaurant: r }: { restaurant: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const left = useCountdown(r.pausedUntil);
  const resume = useMutation({
    mutationFn: () => restaurantApi.resume(r.id),
    onSuccess: (updated) => {
      cacheRestaurant(qc, updated);
      toast({ title: 'Ordering resumed', tone: 'success' });
    },
  });
  if (!r.pausedUntil || !left) return null;
  return (
    <Banner
      tone="warn"
      icon="clock"
      title="Ordering is paused"
      actions={<Button size="sm" onClick={() => resume.mutate()} loading={resume.isPending}>Resume now</Button>}
    >
      <p>Customers can&rsquo;t order from {r.name} until {formatTime(r.pausedUntil)} ({formatDuration(left)} left).</p>
      {resume.isError ? <InlineError error={resume.error} /> : null}
    </Banner>
  );
}
