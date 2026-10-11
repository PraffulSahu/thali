/**
 * Cart page (design-spec §7.2; PRD C-8): one card per restaurant (tray slot pattern, "Delivered separately"),
 * optimistic − / +, "Checkout only {restaurant}" (ORD-3), items subtotal + "Proceed to checkout" (guests sign in
 * first; the guest cart is merged on verify), Clear cart with confirm.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ConfirmDialog, ErrorState, PageHeader, Price, SkeletonCard, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { plural } from '../../lib/format';
import { cartApi, useCart, useCartWriter } from './api';
import { CartGroupSlot } from './CartLines';
import { useDeliveryLabel } from './cartState';
import { checkoutHref, useCheckoutGate } from './CheckoutGate';
import { PageContainer } from './ConsumerLayout';
import { EmptyCart } from './parts';

export default function CartPage() {
  const cart = useCart();
  const write = useCartWriter();
  const label = useDeliveryLabel();
  const { toast } = useToast();
  const { go, dialog } = useCheckoutGate();
  const [confirmClear, setConfirmClear] = useState(false);
  const clear = useMutation({ mutationFn: cartApi.clear, onSuccess: write });
  const c = cart.data;
  const many = (c?.groups.length ?? 0) > 1;

  return (
    <PageContainer>
      <PageHeader size="page" title="Your cart" description="Items from several restaurants are fine — each restaurant cooks and delivers its part separately." />
      {cart.isPending ? (
        <div role="status" aria-busy="true" className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <span className="sr-only">Loading your cart…</span>
          <div className="flex flex-col gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </div>
          <SkeletonCard />
        </div>
      ) : cart.isError ? (
        <ErrorState error={cart.error} title="Couldn't load your cart" onRetry={() => void cart.refetch()} retrying={cart.isFetching} />
      ) : !c || c.groups.length === 0 ? (
        <EmptyCart />
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
            {many ? (
              <p className="flex items-center gap-2 text-[13.5px] text-fg-3">{c.deliveryExplanation ?? 'Each restaurant prepares and delivers its part separately.'} Delivery fees apply per restaurant.</p>
            ) : null}
            {c.groups.map((g, i) => (
              <section
                key={g.restaurantId}
                aria-label={`From ${g.restaurantName}`}
                className="overflow-hidden rounded-card border border-line bg-card [&>div]:border-b-0 [&>div]:border-r-0"
              >
                <CartGroupSlot
                  group={g}
                  linkName
                  deliveryLabel={label(g.restaurantId, i + 1)}
                  action={
                    many ? (
                      <Button variant="outline" size="sm" className="self-start" onClick={() => go(checkoutHref(g.restaurantId))}>
                        Checkout only {g.restaurantName} →
                      </Button>
                    ) : null
                  }
                />
              </section>
            ))}
          </div>
          <aside aria-label="Cart summary" className="flex w-full flex-[1_1_300px] flex-col gap-3.5 rounded-card border border-line bg-card p-5 shadow-card lg:sticky lg:top-6 lg:max-w-[360px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14.5px] text-fg-2">
                {plural(c.itemCount, 'item')} from {plural(c.restaurantCount, 'restaurant')}
              </span>
              <Price paise={c.subtotalPaise} size="xl" />
            </div>
            <p className="text-[13px] text-fg-3">Delivery fees, taxes and discounts are calculated per restaurant at checkout for your address.</p>
            <Button size="lg" fullWidth className="h-[50px]" onClick={() => go(checkoutHref())}>
              Proceed to checkout
            </Button>
            <Button variant="ghost" fullWidth icon="trash" onClick={() => setConfirmClear(true)}>
              Clear cart
            </Button>
          </aside>
        </div>
      )}
      {dialog}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear your cart?"
        description="All items from every restaurant will be removed."
        confirmLabel="Clear cart"
        tone="danger"
        onConfirm={async () => {
          try {
            await clear.mutateAsync();
          } catch (e) {
            toast({ title: "Couldn't clear the cart", description: errorMessage(e), tone: 'danger' });
            throw e;
          }
        }}
      />
    </PageContainer>
  );
}
