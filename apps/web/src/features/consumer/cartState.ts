/**
 * Cart interaction state shared by the dock, tray, drawer, cart page and restaurant page:
 *   - `useLineQuantity()`  optimistic quantity change (PATCH /cart/items/:lineId, 0 → DELETE) with rollback
 *   - `useAddToCart()`     POST /cart/items, writes the server cart, records the "last added" toast
 *   - `useLastAdded()`     "Added Double ka Meetha to Spice Route" pill under the dock (4.5 s)
 *   - `useGroupEta()`      per-restaurant ETA reused from cached discovery results (the cart has no ETA; ORD-8)
 * The server cart is always the truth: every success writes the returned cart into the query cache.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { cartApi, CART_KEY, useCartWriter, type AddItemInput, type Cart, type CartLine, type DiscoveryPage, type RestaurantPageData } from './api';

export const MAX_LINE_QTY = 20;

/** Cart with one line's quantity changed (0 removes it); subtotals and counts recomputed for display. */
export function applyQuantity(cart: Cart, lineId: string, quantity: number): Cart {
  const groups = cart.groups
    .map((g) => {
      const lines = g.lines
        .map((l) => (l.lineId === lineId ? { ...l, quantity, lineTotalPaise: Math.round((l.lineTotalPaise / Math.max(1, l.quantity)) * quantity) } : l))
        .filter((l) => l.quantity > 0);
      return {
        ...g,
        lines,
        itemCount: lines.reduce((n, l) => n + l.quantity, 0),
        subtotalPaise: lines.reduce((n, l) => n + l.lineTotalPaise, 0),
      };
    })
    .filter((g) => g.lines.length > 0);
  return {
    ...cart,
    groups,
    restaurantCount: groups.length,
    itemCount: groups.reduce((n, g) => n + g.itemCount, 0),
    subtotalPaise: groups.reduce((n, g) => n + g.subtotalPaise, 0),
  };
}

function useCartKey() {
  const { user } = useAuth();
  return [...CART_KEY, user?.id ?? 'guest'] as const;
}

/** Optimistic − / + for cart lines (1 → 0 deletes the line). */
export function useLineQuantity() {
  const qc = useQueryClient();
  const key = useCartKey();
  const write = useCartWriter();
  const { toast } = useToast();
  const m = useMutation({
    mutationFn: ({ line, quantity }: { line: CartLine; quantity: number }) =>
      quantity <= 0 ? cartApi.remove(line.lineId) : cartApi.update(line.lineId, { quantity }),
    onMutate: async ({ line, quantity }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Cart>(key);
      if (prev) qc.setQueryData<Cart>(key, applyQuantity(prev, line.lineId, quantity));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast({ title: "Couldn't update your cart", description: errorMessage(e), tone: 'danger' });
    },
    onSuccess: (cart) => write(cart),
  });
  const setQuantity = useCallback(
    (line: CartLine, quantity: number) => m.mutate({ line, quantity: Math.max(0, Math.min(MAX_LINE_QTY, quantity)) }),
    [m],
  );
  return { setQuantity, pending: m.isPending, pendingLineId: m.isPending ? m.variables?.line.lineId : undefined };
}

/* ------------------------------------------------------------------ last added (dock toast) */

export interface LastAdded {
  itemName: string;
  restaurantName: string;
  at: number;
}
let lastAdded: LastAdded | null = null;
const lastListeners = new Set<() => void>();
export function setLastAdded(v: LastAdded | null) {
  lastAdded = v;
  for (const l of [...lastListeners]) l();
}
function subscribeLast(cb: () => void) {
  lastListeners.add(cb);
  return () => lastListeners.delete(cb);
}
export const LAST_ADDED_MS = 4500;

/** The last successful add, for 4.5 s after it happened (then null). */
export function useLastAdded(): LastAdded | null {
  const v = useSyncExternalStore(subscribeLast, () => lastAdded, () => null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!v) return;
    const left = v.at + LAST_ADDED_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [v]);
  return v && Date.now() - v.at < LAST_ADDED_MS ? v : null;
}

/** POST /cart/items → server cart written + dock toast. */
export function useAddToCart() {
  const write = useCartWriter();
  return useMutation({
    mutationFn: (input: AddItemInput) => cartApi.add(input),
    onSuccess: (res) => {
      write(res.cart);
      const group = res.cart.groups.find((g) => g.lines.some((l) => l.lineId === res.lineId));
      const line = group?.lines.find((l) => l.lineId === res.lineId);
      setLastAdded({ itemName: line?.name ?? 'Item', restaurantName: group?.restaurantName ?? 'your cart', at: Date.now() });
    },
  });
}

/* ------------------------------------------------------------------ ETA per cart group (from cached discovery) */

export function cachedEta(qc: QueryClient, restaurantId: string): { minutes: number; source: string } | null {
  for (const [, data] of qc.getQueriesData<{ pages: DiscoveryPage[] }>({ queryKey: ['discovery'] })) {
    for (const p of data?.pages ?? []) {
      const r = p.items.find((i) => i.id === restaurantId);
      if (r) return { minutes: r.etaMinutes, source: r.etaSource };
    }
  }
  for (const [, data] of qc.getQueriesData<RestaurantPageData>({ queryKey: ['restaurant'] })) {
    if (data?.restaurant.id === restaurantId && data.delivery?.etaMinutes != null) {
      return { minutes: data.delivery.etaMinutes, source: data.delivery.etaSource ?? '' };
    }
  }
  return null;
}

/** "DELIVERY 1 · ~32 MIN EST." (ETA only when a cached discovery estimate exists). */
export function useDeliveryLabel() {
  const qc = useQueryClient();
  return (restaurantId: string, n: number) => {
    const eta = cachedEta(qc, restaurantId);
    return `Delivery ${n}${eta ? ` · ~${eta.minutes} min est.` : ''}`;
  };
}
