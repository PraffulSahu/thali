/**
 * Admin ⌘K global search (board 40 element 40-02). One input, routed by what was typed:
 *   TH-…            → orders (ORD-1 `GET /admin/orders/checkouts?q=`)
 *   4–13 digits     → customer phone (ORD-7: the same `q`, matched on the indexed last 4) + users by phone
 *   anything else   → users (`GET /admin/users?q=`) and restaurants (`GET /admin/marketplace/restaurants?q=`)
 * Results are a WAI-ARIA combobox/listbox; Enter opens the highlighted result.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../../components/ui/Dialog';
import { Icon, type IconName } from '../../components/ui/Icon';
import { Spinner } from '../../components/ui/Spinner';
import { StatusPill } from '../../components/ui/StatusPill';
import { Kbd } from '../../components/ui/Typography';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useHotkey } from '../../hooks/useHotkey';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatPhone } from '../../lib/format';
import { listCheckouts, listRestaurants, listUsers } from './api';
import { customerLabel } from './ui';

/* ------------------------------------------------------------------ open/close store (shared by every trigger) */

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const openCommandPalette = () => {
  open = true;
  emit();
};
export const closeCommandPalette = () => {
  open = false;
  emit();
};
export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
    () => false,
  );
}

/* ------------------------------------------------------------------ classification */

export type SearchKind = 'empty' | 'order' | 'phone' | 'text';

/** TH- code → orders; 4–13 digits (spaces, +, - ignored) → phone; else free text. */
export function classifySearch(raw: string): { kind: SearchKind; term: string } {
  const q = raw.trim();
  if (!q) return { kind: 'empty', term: '' };
  if (/^th-/i.test(q)) return { kind: 'order', term: q.toUpperCase() };
  const digits = q.replace(/[\s+()-]/g, '');
  if (/^\d+$/.test(digits)) {
    // "+91 98765 43210" → last 10 national digits; 4–13 digits is a phone search (ORD-7).
    const national = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
    if (national.length >= 4 && national.length <= 13) return { kind: 'phone', term: national };
  }
  return { kind: 'text', term: q };
}

interface Result {
  id: string;
  group: 'Orders' | 'Users' | 'Restaurants' | 'More';
  icon: IconName;
  title: string;
  detail?: string;
  aside?: React.ReactNode;
  to: string;
}

function useResults(raw: string, enabled: boolean) {
  const debounced = useDebouncedValue(raw, 250);
  const { kind, term } = classifySearch(debounced);
  const ordersOn = enabled && (kind === 'order' || kind === 'phone');
  const usersOn = enabled && (kind === 'phone' || kind === 'text');
  const restaurantsOn = enabled && kind === 'text';
  const orders = useQuery({ queryKey: ['admin', 'palette', 'orders', term], queryFn: () => listCheckouts({ q: term, limit: 6 }), enabled: ordersOn, staleTime: 15_000 });
  const users = useQuery({ queryKey: ['admin', 'palette', 'users', term], queryFn: () => listUsers({ q: term, limit: 5 }), enabled: usersOn, staleTime: 15_000 });
  const restaurants = useQuery({
    queryKey: ['admin', 'palette', 'restaurants', term],
    queryFn: () => listRestaurants({ q: term, limit: 5 }),
    enabled: restaurantsOn,
    staleTime: 15_000,
  });

  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    if (ordersOn) {
      for (const o of orders.data?.items ?? []) {
        out.push({
          id: `o:${o.id}`,
          group: 'Orders',
          icon: 'receipt',
          title: o.code,
          detail: `${customerLabel(o.customer)} · ${o.restaurants.map((r) => r.name).join(', ')}`,
          aside: <StatusPill kind="checkout" status={o.status} density="dense" />,
          to: `/admin/orders/${o.id}`,
        });
      }
    }
    if (usersOn) {
      for (const u of users.data?.items ?? []) {
        out.push({
          id: `u:${u.id}`,
          group: 'Users',
          icon: 'user',
          title: u.name || u.email || formatPhone(u.phone) || u.id,
          detail: [formatPhone(u.phone), u.email, u.roles.join(', ').toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · '),
          to: `/admin/users?q=${encodeURIComponent(u.id)}`,
        });
      }
    }
    if (restaurantsOn) {
      for (const r of restaurants.data?.items ?? []) {
        out.push({
          id: `r:${r.id}`,
          group: 'Restaurants',
          icon: 'store',
          title: r.name,
          detail: r.address?.city ?? undefined,
          aside: <StatusPill kind="restaurant" status={r.status} density="dense" />,
          to: `/admin/restaurants/${r.id}`,
        });
      }
    }
    if (kind !== 'empty') {
      const q = encodeURIComponent(term);
      if (kind !== 'text' || term.length >= 2) out.push({ id: 'all-orders', group: 'More', icon: 'search', title: `Search all orders for “${term}”`, to: `/admin/orders?q=${q}&range=all` });
      if (kind !== 'order') out.push({ id: 'all-users', group: 'More', icon: 'users', title: `Search users for “${term}”`, to: `/admin/users?q=${q}` });
    }
    return out;
  }, [kind, term, ordersOn, usersOn, restaurantsOn, orders.data, users.data, restaurants.data]);

  const fetching = (ordersOn && orders.isFetching) || (usersOn && users.isFetching) || (restaurantsOn && restaurants.isFetching) || raw !== debounced;
  const errors = [ordersOn && orders.error, usersOn && users.error, restaurantsOn && restaurants.error].filter(Boolean) as unknown[];
  return { kind, term, results, fetching, errors, settled: raw === debounced };
}

const KIND_HINT: Record<SearchKind, string> = {
  empty: 'Type an order code (TH-…), a phone number, or a name.',
  order: 'Searching orders by code',
  phone: 'Searching orders and users by phone (last 4 digits)',
  text: 'Searching users and restaurants',
};

export function CommandPalette() {
  const isOpen = useCommandPaletteOpen();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const { kind, results, fetching, errors, settled } = useResults(q, isOpen);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    if (!isOpen) setQ('');
  }, [isOpen]);
  useEffect(() => setActive(0), [results.length, q]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    closeCommandPalette();
    navigate(r.to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Results still belong to the previous term while the debounce runs: search the CURRENT term instead.
      if (!settled) {
        const now = classifySearch(q);
        if (now.kind === 'empty') return;
        const term = encodeURIComponent(now.term);
        go({ id: 'flush', group: 'More', icon: 'search', title: now.term, to: now.kind === 'text' ? `/admin/users?q=${term}` : `/admin/orders?q=${term}&range=all` });
        return;
      }
      go(results[active]);
    }
  };

  let lastGroup = '';
  return (
    <Dialog open={isOpen} onClose={closeCommandPalette} title="Search" hideClose initialFocusRef={inputRef} size="lg">
      <div className="flex flex-col gap-3">
        <label className="flex h-11 items-center gap-2.5 rounded-control border border-line bg-card px-3 focus-within:border-acc">
          <Icon name="search" size={16} className="text-fg-3" />
          <span className="sr-only">Search orders, phones, users and restaurants</span>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search orders, phones…"
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3"
          />
          {fetching && kind !== 'empty' ? <Spinner size={16} label={null} /> : null}
          <Kbd className="text-[10.5px]">esc</Kbd>
        </label>
        <p className="text-[12.5px] text-fg-3" aria-live="polite">
          {KIND_HINT[kind]}
        </p>
        {errors.length ? (
          <p role="alert" className="text-[13px] text-bad">
            Some results couldn't load: {errorMessage(errors[0])}
          </p>
        ) : null}
        <ul id={listId} role="listbox" aria-label="Search results" className="-mx-1 flex max-h-[50dvh] flex-col overflow-y-auto">
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <li key={r.id} role="none">
                {header ? <p className="lbl px-2 pb-1 pt-2.5 text-[11px]!">{header}</p> : null}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn('flex cursor-pointer items-center gap-3 rounded-item px-2 py-2', i === active ? 'bg-fill' : 'hover:bg-bg-2')}
                >
                  <Icon name={r.icon} size={16} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[14px] text-fg', r.group === 'Orders' && 'font-mono')}>{r.title}</span>
                    {r.detail ? <span className="block truncate text-[12.5px] text-fg-3">{r.detail}</span> : null}
                  </span>
                  {r.aside}
                </div>
              </li>
            );
          })}
          {kind !== 'empty' && !fetching && results.filter((r) => r.group !== 'More').length === 0 && errors.length === 0 ? (
            <li role="none" className="px-2 py-3 text-[13.5px] text-fg-3">
              No direct matches.
            </li>
          ) : null}
        </ul>
      </div>
    </Dialog>
  );
}

/** ⌘K / Ctrl+K hotkey + the palette itself; mount once inside the admin shell. */
export function CommandPaletteHost() {
  const auth = useAuth();
  const enabled = auth.hasRole('ADMIN') && auth.hasMfa;
  useHotkey('k', openCommandPalette, { meta: true, enabled });
  return enabled ? <CommandPalette /> : null;
}
