import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StoreSettingsPage from '../../src/features/restaurant/StoreSettingsPage';
import { makeAuth, renderWithProviders } from '../utils';
import { json, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const render = (r = makeRestaurant()) => renderWithProviders(withRestaurant(r, <StoreSettingsPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('StoreSettingsPage', () => {
  it('pauses ordering for 15, 30 or 60 minutes', async () => {
    const api = mockApi([['POST', /pause$/, () => json(makeRestaurant({ pausedUntil: new Date(Date.now() + 30 * 60_000).toISOString() }))]]);
    const user = userEvent.setup();
    render();
    expect(screen.getByRole('button', { name: '15 min' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '60 min' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '30 min' }));
    await user.click(screen.getByRole('button', { name: 'Pause for 30 min' }));
    await waitFor(() => expect(api.find('POST', /pause$/)).toHaveLength(1));
    expect(api.find('POST', /pause$/)[0]!.body).toEqual({ minutes: 30 });
  });

  it('shows the paused state with Resume', async () => {
    const api = mockApi([['POST', /resume$/, () => json(makeRestaurant())]]);
    const user = userEvent.setup();
    render(makeRestaurant({ pausedUntil: new Date(Date.now() + 20 * 60_000).toISOString() }));
    await user.click(screen.getByRole('button', { name: /resume ordering now/i }));
    await waitFor(() => expect(api.find('POST', /resume$/)).toHaveLength(1));
  });

  it('saves hours including an overnight slot', async () => {
    const api = mockApi([['PUT', /hours$/, () => json(makeRestaurant())]]);
    const user = userEvent.setup();
    render();
    const monday = screen.getByRole('group', { name: 'Monday' });
    fireEvent.change(within(monday).getByLabelText('Monday slot 1 opens'), { target: { value: '18:00' } });
    fireEvent.change(within(monday).getByLabelText('Monday slot 1 closes'), { target: { value: '02:00' } });
    expect(within(monday).getByText(/closes after midnight/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save hours/i }));
    await waitFor(() => expect(api.find('PUT', /hours$/)).toHaveLength(1));
    expect(api.find('PUT', /hours$/)[0]!.body).toEqual({ hours: [{ day: 1, open: '18:00', close: '02:00' }] });
  });

  it('refuses to save an empty week and says why', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    render(makeRestaurant({ hours: [{ day: 1, open: '10:00', close: '22:00' }] }));
    await user.click(within(screen.getByRole('group', { name: 'Monday' })).getByRole('switch', { name: /monday/i }));
    await user.click(screen.getByRole('button', { name: /save hours/i }));
    expect(await screen.findByText(/add opening hours for at least one day/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('validates kitchen defaults and sends paise', async () => {
    const api = mockApi([['PATCH', /\/owner\/restaurants\/r1$/, () => json(makeRestaurant({ packagingFeePaise: 1250 }))]]);
    const user = userEvent.setup();
    render();
    const fee = screen.getByLabelText(/packaging fee/i);
    await user.clear(fee);
    await user.type(fee, '12.50');
    const prep = screen.getByLabelText(/average prep time/i);
    await user.clear(prep);
    await user.type(prep, '3');
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByText(/between 5 and 120/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
    await user.clear(prep);
    await user.type(prep, '25');
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(api.find('PATCH', /r1$/)).toHaveLength(1));
    expect(api.find('PATCH', /r1$/)[0]!.body).toEqual({ avgPrepMinutes: 25, packagingFeePaise: 1250, deliveryRadiusKm: 6 });
  });
});
