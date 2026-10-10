import '../setup';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CartPage from '../../src/features/consumer/CartPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { GUEST_CART_STORAGE_KEY } from '../../src/lib/guest';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';
import { IDS, twoRestaurantCart } from './fixtures';

describe('CartPage', () => {
  beforeEach(() => __resetApiForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('renders one group per restaurant with its subtotal and the separate-delivery note', async () => {
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
    mockApi({ 'GET /cart': twoRestaurantCart() });
    renderWithProviders(<CartPage />, { auth: makeAuth({ roles: ['CONSUMER'] }) });
    const groups = await screen.findAllByRole('region', { name: /from /i });
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getByRole('heading', { name: 'Spice Route' })).toBeInTheDocument();
    expect(within(groups[0]!).getByText(/subtotal/i).parentElement).toHaveTextContent('₹480');
    expect(within(groups[1]!).getByRole('heading', { name: 'Dosa Corner' })).toBeInTheDocument();
    expect(within(groups[1]!).getByText(/subtotal/i).parentElement).toHaveTextContent('₹200');
    expect(screen.getAllByText(/delivered separately/i).length).toBeGreaterThanOrEqual(2);
  });

  it('removing a line calls DELETE /cart/items/:lineId and shows the updated cart', async () => {
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
    const after = twoRestaurantCart();
    after.groups = [after.groups[0]!];
    after.restaurantCount = 1;
    const m = mockApi({ 'GET /cart': twoRestaurantCart(), [`DELETE /cart/items/${IDS.L3}`]: after });
    renderWithProviders(<CartPage />, { auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: /remove filter coffee/i }));
    expect(m.callsTo('DELETE', `/cart/items/${IDS.L3}`)).toHaveLength(1);
    expect(await screen.findAllByRole('region', { name: /from /i })).toHaveLength(1);
  });

  it('signed out without a guest token shows an empty cart without calling the API', async () => {
    const m = mockApi({});
    renderWithProviders(<CartPage />);
    expect(await screen.findByText(/your cart is empty/i)).toBeInTheDocument();
    expect(m.calls).toHaveLength(0);
  });

  it('guest cart: sends X-Guest-Cart and asks to sign in before checkout', async () => {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, 'guest-token-abc');
    const m = mockApi({ 'GET /cart': { ...twoRestaurantCart(), ownerType: 'GUEST' } });
    renderWithProviders(<CartPage />);
    await userEvent.click(await screen.findByRole('button', { name: /sign in to checkout/i }));
    expect(m.callsTo('GET', '/cart')[0]!.headers['x-guest-cart']).toBe('guest-token-abc');
    expect(await screen.findByRole('dialog', { name: /sign in/i })).toBeInTheDocument();
  });
});
