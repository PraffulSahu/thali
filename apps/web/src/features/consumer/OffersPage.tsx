/**
 * Offers (MKT-7, guest + signed in; linked from the public header). `GET /coupons/available` with optional auth:
 * guests see every live coupon marked "Sign in to check eligibility"; signed-in users see the coupons they can
 * apply right now (first-order rule, per-user limit). Each card: headline, code (copy), terms, scope (MKT-8), and
 * "Apply to cart" (`PUT /cart/coupon`) when there's a cart — the checkout preview decides if it applies.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, ButtonLink, EmptyState, ErrorState, Icon, SkeletonCard, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { formatDate, formatINR } from '../../lib/format';
import { cartApi, couponsKey, fetchCoupons, useCart, useCartWriter, type AvailableCoupon } from './api';
import { LoginDialog } from './LoginDialog';
import { Accent } from './parts';

function headline(c: AvailableCoupon): string {
  if (c.offerHeadline) return c.offerHeadline;
  if (c.type === 'PERCENT' && c.valueBps) return `${c.valueBps / 100}% off${c.maxDiscountPaise ? ` up to ${formatINR(c.maxDiscountPaise).replace(/\.00$/, '')}` : ''}`;
  if (c.valuePaise) return `${formatINR(c.valuePaise).replace(/\.00$/, '')} off`;
  return c.code;
}

function OfferCard({ c, signedIn, hasCart, onSignIn }: { c: AvailableCoupon; signedIn: boolean; hasCart: boolean; onSignIn: () => void }) {
  const { toast } = useToast();
  const write = useCartWriter();
  const [copied, setCopied] = useState(false);
  const apply = useMutation({
    mutationFn: () => cartApi.setCoupon(c.code),
    onSuccess: (cart) => {
      write(cart);
      toast({ title: `${c.code} added to your cart`, description: 'Checkout shows exactly what it saves on each restaurant.', tone: 'success' });
    },
    onError: (e) => toast({ title: `Couldn't apply ${c.code}`, description: errorMessage(e), tone: 'danger' }),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: `Code: ${c.code}`, tone: 'neutral' });
    }
  };
  const terms = [
    c.minOrderPaise ? `Min order ${formatINR(c.minOrderPaise).replace(/\.00$/, '')}` : null,
    c.firstOrderOnly ? 'First order only' : null,
    c.validTo ? `Valid till ${formatDate(c.validTo)}` : null,
    c.remainingUses != null ? `${c.remainingUses} use${c.remainingUses === 1 ? '' : 's'} left` : null,
    c.restaurantIds?.length ? `At ${c.restaurantIds.length === 1 ? 'one restaurant' : `${c.restaurantIds.length} restaurants`}` : 'Every restaurant',
  ].filter(Boolean);
  return (
    <li className="flex list-none flex-col gap-3.5 rounded-card border border-line bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-item bg-ok-bg text-ok">
          <Icon name="tag" size={18} />
        </span>
        {c.badgeLabel ? (
          <span className="rounded-badge bg-[var(--offer-bg)] px-2 py-[5px] text-[11px] font-extrabold leading-none text-[var(--offer-fg)]">{c.badgeLabel}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl">{headline(c)}</h2>
        {c.description ? <p className="text-sm text-fg-2">{c.description}</p> : null}
      </div>
      <p className="text-[13px] text-fg-3">{terms.join(' · ')}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-dashed border-line-2 pt-3.5">
        <span className="font-mono text-[15px] font-medium tracking-wide">{c.code}</span>
        <Button variant="ghost" size="xs" icon={copied ? 'check' : 'copy'} onClick={() => void copy()} aria-label={`Copy code ${c.code}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <span className="ml-auto">
          {!signedIn || c.eligibility === 'SIGN_IN_TO_CHECK' ? (
            <Button variant="outline" size="sm" onClick={onSignIn}>
              Sign in to check
            </Button>
          ) : hasCart ? (
            <Button size="sm" loading={apply.isPending} onClick={() => apply.mutate()}>
              Apply to cart
            </Button>
          ) : (
            <Badge tone="ok">You can use this</Badge>
          )}
        </span>
      </div>
    </li>
  );
}

export default function OffersPage() {
  const { isAuthenticated } = useAuth();
  const cart = useCart();
  const [login, setLogin] = useState(false);
  const q = useQuery({ queryKey: couponsKey(isAuthenticated), queryFn: () => fetchCoupons(isAuthenticated), staleTime: 60_000 });
  const hasCart = (cart.data?.itemCount ?? 0) > 0;
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 pb-12 pt-8 max-sm:px-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[34px] leading-[1.05] max-sm:text-[28px]">
            Offers, <Accent>no fine print.</Accent>
          </h1>
          <p className="max-w-prose text-[15px] text-fg-3">
            {isAuthenticated
              ? 'Coupons you can use right now. Checkout shows exactly what each one saves, split across restaurants.'
              : 'Every live coupon on Thali. Sign in to see which ones you can use — some are for first orders only.'}
          </p>
        </div>
        {hasCart ? (
          <ButtonLink to="/checkout" variant="outline" iconRight="arrow-right">
            Go to checkout
          </ButtonLink>
        ) : null}
      </header>
      {q.isPending ? (
        <div role="status" aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-4">
          <span className="sr-only">Loading offers…</span>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} title="Couldn't load offers" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.length === 0 ? (
        <EmptyState icon="tag" title="No offers right now" description="New offers show up here first. Meanwhile, Thali Plus gives free deliveries on eligible orders." action={<ButtonLink to="/membership" variant="outline">See Thali Plus</ButtonLink>} />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-4">
          {q.data.map((c) => (
            <OfferCard key={c.code} c={c} signedIn={isAuthenticated} hasCart={hasCart} onSignIn={() => setLogin(true)} />
          ))}
        </ul>
      )}
      <LoginDialog open={login} onClose={() => setLogin(false)} reason="Sign in to see which offers you can use." onSignedIn={() => setLogin(false)} />
    </div>
  );
}
