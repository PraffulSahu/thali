import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RestaurantLayout from '../../src/features/restaurant/RestaurantLayout';
import { useCurrentRestaurant } from '../../src/features/restaurant/RestaurantContext';
import { setSelectedRestaurantId } from '../../src/features/restaurant/selection';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, makeRestaurant, mockApi } from './fixtures';

function Child() {
  const r = useCurrentRestaurant();
  return <p>Working on {r.name}</p>;
}
const render = () =>
  renderWithProviders(
    <Routes>
      <Route element={<RestaurantLayout />}>
        <Route index element={<Child />} />
      </Route>
    </Routes>,
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

  it('lets an owner with several stores switch between them', async () => {
    mockApi([
      ['GET', /^\/owner\/restaurants$/, { items: [makeRestaurant({ id: 'r1', name: 'Spice Route' }), makeRestaurant({ id: 'r2', name: 'Dosa Corner' })] }],
      ['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }],
    ]);
    const user = userEvent.setup();
    render();
    expect(await screen.findByText('Working on Spice Route')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Restaurant'), 'r2');
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
    expect(await screen.findByRole('heading', { name: /your restaurant is suspended/i })).toBeInTheDocument();
    expect(screen.getByText('Safety audit')).toBeInTheDocument();
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
