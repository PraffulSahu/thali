import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPaletteHost, closeCommandPalette } from '../../src/features/admin/CommandPalette';
import { renderWithProviders } from '../utils';
import { adminAuth, checkoutRow, json, pendingRestaurant, routeFetch } from './fixtures';

afterEach(() => {
  act(() => closeCommandPalette());
  vi.unstubAllGlobals();
});

const user1 = { id: 'u9', phone: '+919876543210', email: null, name: 'Ananya Iyer', roles: ['CONSUMER'], adminRoles: [], status: 'ACTIVE', addresses: [], createdAt: '2026-10-01T00:00:00.000Z' };

function setup() {
  const calls = routeFetch([
    ['/admin/orders/checkouts', () => json({ items: [checkoutRow], nextCursor: null })],
    ['/admin/users', () => json({ items: [user1], nextCursor: null })],
    ['/admin/marketplace/restaurants', () => json({ items: [pendingRestaurant], nextCursor: null })],
  ]);
  const view = renderWithProviders(<CommandPaletteHost />, { route: '/admin', auth: adminAuth(['OPS']) });
  return { calls, ...view };
}

describe('Admin ⌘K search', () => {
  it('opens with Ctrl+K, routes a TH- code to orders and Enter opens the investigation', async () => {
    const user = userEvent.setup();
    const { calls, router } = setup();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox');
    await user.type(input, 'th-demo');
    expect(await screen.findByRole('option', { name: /TH-DEMOMULTI/ })).toBeInTheDocument();
    const url = new URL(calls.find((c) => c.url.includes('/admin/orders/checkouts'))!.url, 'http://x');
    expect(url.searchParams.get('q')).toBe('TH-DEMO');
    expect(calls.some((c) => c.url.includes('/admin/users'))).toBe(false);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orders/chk1'));
  });

  it('treats 4–13 digits as a phone (ORD-7) and searches orders and users', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(await screen.findByRole('combobox'), '+91 98765 43210');
    expect(await screen.findByRole('option', { name: /Ananya Iyer/ })).toBeInTheDocument();
    expect(screen.getByText(/by phone/i)).toBeInTheDocument();
    const orders = calls.filter((c) => c.url.includes('/admin/orders/checkouts')).map((c) => new URL(c.url, 'http://x').searchParams.get('q'));
    expect(orders).toContain('9876543210');
    expect(calls.some((c) => c.url.includes('/admin/marketplace/restaurants'))).toBe(false);
  });

  it('searches users and restaurants for free text', async () => {
    const user = userEvent.setup();
    const { calls, router } = setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'Tandoor');
    await user.click(await screen.findByRole('option', { name: /Tandoor Tales/ }));
    expect(calls.some((c) => c.url.includes('/admin/orders/checkouts'))).toBe(false);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/restaurants/rest1'));
  });
});
