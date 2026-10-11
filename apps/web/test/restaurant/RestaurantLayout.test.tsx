import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RestaurantLayout from '../../src/features/restaurant/RestaurantLayout';
import { useCurrentRestaurant } from '../../src/features/restaurant/RestaurantContext';
import { setSelectedRestaurantId } from '../../src/features/restaurant/selection';
import { RestaurantSwitcher } from '../../src/features/restaurant/RestaurantSwitcher';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, makeRestaurant, mockApi } from './fixtures';

function Child() {
  const r = useCurrentRestaurant();
  return <p>Working on {r.name}</p>;
}
const render = () =>
  renderWithProviders(
    <>
      <RestaurantSwitcher />
      <Routes>
        <Route element={<RestaurantLayout />}>
          <Route index element={<Child />} />
        </Route>
      </Routes>
    </>,
    { route: '/restaurant', path: '/restaurant/*', auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) },
  );

afterEach(() => vi.unstubAllGlobals());

describe('RestaurantLayout', () => {
  it('invites an owner with no restaurant to start onboarding', async () => {
    mockApi([['GET', /^\/owner\/restaurants$/, { items: [] }]]);
    render();
    expect(await screen.findByRole('heading', { name: /register your restaurant/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start onboarding/i })).toHaveAttribute('href', '/restaurant/onboarding');
  });

  it('lets an owner with several stores switch between them from the sidebar switcher (locality + status shown)', async () => {
    mockApi([
      ['GET', /^\/owner\/restaurants$/, { items: [makeRestaurant({ id: 'r1', name: 'Spice Route', address: { line1: '1', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' } }), makeRestaurant({ id: 'r2', name: 'Dosa Corner', status: 'APPROVAL_PENDING' })] }],
      ['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }],
    ]);
    const user = userEvent.setup();
    render();
    expect(await screen.findByText('Working on Spice Route')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch restaurant. Current: Spice Route, Indiranagar' }));
    const menu = screen.getByRole('dialog', { name: 'Switch restaurant' });
    expect(within(menu).getByText('Awaiting approval')).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Add restaurant' })).toHaveAttribute('href', '/restaurant/onboarding');
    await user.click(within(menu).getByRole('button', { name: /Dosa Corner/ }));
    expect(await screen.findByText('Working on Dosa Corner')).toBeInTheDocument();
    expect(localStorage.getItem('thali.restaurant.selected')).toBe('r2');
  });

  it('falls back to the first restaurant when the saved selection no longer exists', async () => {
    setSelectedRestaurantId('gone');
    mockApi([
      ['GET', /^\/owner\/restaurants$/, { items: [makeRestaurant({ id: 'r1', name: 'Spice Route' })] }],
      ['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }],
    ]);
    render();
    expect(await screen.findByText('Working on Spice Route')).toBeInTheDocument();
  });

  it('shows the status banner for the selected restaurant', async () => {
    mockApi([['GET', /^\/owner\/restaurants$/, { items: [makeRestaurant({ status: 'SUSPENDED', statusReason: 'Safety audit' })] }]]);
    render();
    expect(await screen.findByText('Restaurant suspended')).toBeInTheDocument();
    expect(screen.getByText(/Safety audit/)).toBeInTheDocument();
  });

  it('shows a forbidden state when the API refuses the owner role', async () => {
    mockApi([['GET', /^\/owner\/restaurants$/, () => apiError(403, 'FORBIDDEN', 'No')]]);
    render();
    await waitFor(() => expect(screen.getByRole('heading', { name: /access|permission|allowed|forbidden/i })).toBeInTheDocument());
  });

  it('offers retry when loading fails', async () => {
    mockApi([['GET', /^\/owner\/restaurants$/, () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'down')]]);
    render();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
