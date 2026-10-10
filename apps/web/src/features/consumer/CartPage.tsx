/**
 * Multi-restaurant cart (PRD C-8, §4.5): one group per restaurant with its own subtotal and the
 * "Delivered separately" note; quantity changes, removal, clear. Guests use the server-side guest cart
 * (X-Guest-Cart); checkout requires sign-in (LoginDialog keeps the cart).
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  ButtonLink,
  Card,
  ConfirmDialog,
  FoodMarker,
  IconButton,
  PageHeader,
  Price,
  QueryState,
  SkeletonList,
  useToast,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { plural } from '../../lib/format';
import { cartApi, useCart, useCartWriter, type Cart, type CartGroup, type CartLine } from './api';
import { LoginDialog } from './LoginDialog';
import { SeparateDeliveryNote } from './parts';

function LineRow({ line }: { line: CartLine }) {
  const write = useCartWriter();
  const { toast } = useToast();
  const onError = (e: unknown) => toast({ title: "Couldn't update your cart", description: errorMessage(e), tone: 'danger' });
  const qty = useMutation({ mutationFn: (q: number) => cartApi.update(line.lineId, { quantity: q }), onSuccess: write, onError });
  const remove = useMutation({ mutationFn: () => cartApi.remove(line.lineId), onSuccess: write, onError });
  const busy = qty.isPending || remove.isPending;
  return (
    <li className="flex gap-3 py-3">
      <FoodMarker veg={line.isVeg} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-900">{line.name}</p>
        {line.addOns.length ? <p className="text-sm text-slate-600">{line.addOns.map((a) => a.name).join(', ')}</p> : null}
        {line.note ? <p className="text-sm italic text-slate-600">“{line.note}”</p> : null}
        <p className="text-sm text-slate-600">
          <Price paise={line.unitPricePaise + line.addOns.reduce((s, a) => s + a.pricePaise, 0)} size="sm" tone="muted" /> each
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Price paise={line.lineTotalPaise} />
        <div className="flex items-center rounded-control border border-slate-300" role="group" aria-label={`Quantity of ${line.name}`}>
          <IconButton
            icon={line.quantity <= 1 ? 'trash' : 'minus'}
            label={line.quantity <= 1 ? `Remove ${line.name}` : `Decrease ${line.name}`}
            size="sm"
            disabled={busy}
            onClick={() => (line.quantity <= 1 ? remove.mutate() : qty.mutate(line.quantity - 1))}
          />
          <span className="w-7 text-center text-sm font-semibold tabular-nums" aria-live="polite">
            {line.quantity}
          </span>
          <IconButton icon="plus" label={`Increase ${line.name}`} size="sm" disabled={busy || line.quantity >= 20} onClick={() => qty.mutate(line.quantity + 1)} />
        </div>
        {line.quantity > 1 ? (
          <Button variant="link" size="sm" onClick={() => remove.mutate()} disabled={busy} aria-label={`Remove ${line.name}`}>
            Remove
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function CartGroupCard({ group, compact }: { group: CartGroup; compact?: boolean }) {
  const headingId = `cart-group-${group.restaurantId}`;
  return (
    <Card as="section" aria-label={`From ${group.restaurantName}`} padding={compact ? 'sm' : 'md'}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold text-slate-900">
          <Link to={`/restaurants/${group.restaurantId}`} className="hover:underline">
            {group.restaurantName}
          </Link>
        </h2>
        <SeparateDeliveryNote note={group.delivery?.note} />
      </div>
      <ul className="divide-y divide-slate-100">
        {group.lines.map((l) => (
          <LineRow key={l.lineId} line={l} />
        ))}
      </ul>
      <div className="flex items-baseline justify-between border-t border-slate-200 pt-2 font-semibold">
        <span>Subtotal · {plural(group.itemCount, 'item')}</span>
        <Price paise={group.subtotalPaise} />
      </div>
    </Card>
  );
}

export function CartGroups({ cart, compact }: { cart: Cart; compact?: boolean }) {
  return (
    <div className="space-y-4">
      {cart.restaurantCount > 1 ? (
        <p className="rounded-control bg-info-50 px-3 py-2 text-sm text-info-800">
          {cart.deliveryExplanation ?? 'Each restaurant prepares and delivers its part of the order separately.'} Delivery fees apply per restaurant.
        </p>
      ) : null}
      {cart.groups.map((g) => (
        <CartGroupCard key={g.restaurantId} group={g} compact={compact} />
      ))}
    </div>
  );
}

export default function CartPage() {
  const cart = useCart();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const write = useCartWriter();
  const { toast } = useToast();
  const [login, setLogin] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const clear = useMutation({ mutationFn: cartApi.clear, onSuccess: write });

  return (
    <>
      <PageHeader title="Your cart" description="Items from several restaurants are fine — each restaurant delivers its part separately." />
      <QueryState
        query={cart}
        loading={<SkeletonList count={2} />}
        isEmpty={(c) => c.groups.length === 0}
        empty={{
          icon: 'cart',
          title: 'Your cart is empty',
          description: 'Add dishes from any restaurant that delivers to you.',
          action: <ButtonLink to="/">Find restaurants</ButtonLink>,
        }}
      >
        {(c) => (
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <CartGroups cart={c} />
            <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
              <Card>
                <dl className="space-y-1">
                  <div className="flex justify-between text-sm text-slate-700">
                    <dt>
                      {plural(c.itemCount, 'item')} from {plural(c.restaurantCount, 'restaurant')}
                    </dt>
                    <dd>
                      <Price paise={c.subtotalPaise} />
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-sm text-slate-600">Delivery fees, taxes and discounts are calculated at checkout for your address.</p>
                <div className="mt-4 space-y-2">
                  {isAuthenticated ? (
                    <ButtonLink to="/checkout" fullWidth size="lg" iconRight="chevron-right">
                      Proceed to checkout
                    </ButtonLink>
                  ) : (
                    <Button fullWidth size="lg" icon="phone" onClick={() => setLogin(true)}>
                      Sign in to checkout
                    </Button>
                  )}
                  <Button variant="ghost" fullWidth icon="trash" onClick={() => setConfirmClear(true)}>
                    Clear cart
                  </Button>
                </div>
              </Card>
            </aside>
          </div>
        )}
      </QueryState>
      <LoginDialog open={login} onClose={() => setLogin(false)} onSignedIn={() => navigate('/checkout')} />
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
    </>
  );
}
