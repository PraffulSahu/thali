import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBanner } from '../../src/features/restaurant/StatusBanner';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, completeDraft, json, makeRestaurant, mockApi } from './fixtures';

const render = (r = makeRestaurant()) => renderWithProviders(<StatusBanner restaurant={r} />, { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('StatusBanner', () => {
  it('verification pending: explains, resends, then enters a cooldown', async () => {
    const api = mockApi([['POST', /resend-verification$/, () => json({ sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString() }, 202)]]);
    const user = userEvent.setup();
    render(makeRestaurant({ status: 'VERIFICATION_PENDING', emailVerification: { sentAt: '2026-10-01T00:00:00.000Z', expiresAt: null } }));
    expect(screen.getByRole('heading', { name: /verify your business email/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /resend verification email/i }));
    await waitFor(() => expect(api.find('POST', /resend-verification$/)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /resend in/i })).toBeDisabled();
  });

  it('verification pending: honours a server rate limit', async () => {
    mockApi([['POST', /resend-verification$/, () => apiError(429, 'RATE_LIMITED', 'Please wait before requesting another email.')]]);
    const user = userEvent.setup();
    render(makeRestaurant({ status: 'VERIFICATION_PENDING' }));
    await user.click(screen.getByRole('button', { name: /resend verification email/i }));
    expect(await screen.findByText(/please wait a moment and try again/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /resend in/i })).toBeDisabled();
  });

  it('approval pending', () => {
    render(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(screen.getByRole('heading', { name: /awaiting approval/i })).toBeInTheDocument();
  });

  it('rejected: shows the reason and resubmits', async () => {
    const api = mockApi([['POST', /submit$/, () => json(completeDraft({ status: 'APPROVAL_PENDING' }))]]);
    const user = userEvent.setup();
    render(makeRestaurant({ status: 'REJECTED', statusReason: 'FSSAI licence is blurry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('FSSAI licence is blurry');
    expect(screen.getByRole('link', { name: /edit details/i })).toHaveAttribute('href', '/restaurant/onboarding/r1');
    await user.click(screen.getByRole('button', { name: /resubmit for review/i }));
    await waitFor(() => expect(api.find('POST', /submit$/)).toHaveLength(1));
  });

  it('suspended: shows the reason', () => {
    render(makeRestaurant({ status: 'SUSPENDED', statusReason: 'Hygiene complaint under review' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Hygiene complaint under review');
  });

  it('draft links to the wizard; approved shows nothing unless paused', () => {
    const { unmount } = render(makeRestaurant({ status: 'DRAFT' }));
    expect(screen.getByRole('link', { name: /continue setup/i })).toHaveAttribute('href', '/restaurant/onboarding/r1');
    unmount();
    const approved = render(makeRestaurant({ status: 'APPROVED' }));
    expect(approved.container).toBeEmptyDOMElement();
  });

  it('approved and paused: shows when ordering resumes with a Resume button', () => {
    render(makeRestaurant({ pausedUntil: new Date(Date.now() + 15 * 60_000).toISOString() }));
    expect(screen.getByRole('heading', { name: /ordering is paused/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume now/i })).toBeInTheDocument();
  });
});
