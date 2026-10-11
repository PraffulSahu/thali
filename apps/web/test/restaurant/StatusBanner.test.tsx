import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBanner } from '../../src/features/restaurant/StatusBanner';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, json, makeRestaurant, mockApi } from './fixtures';

const render = (r = makeRestaurant()) => renderWithProviders(<StatusBanner restaurant={r} />, { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('StatusBanner (design-spec 20-11)', () => {
  it('verification pending: explains, resends, then enters a cooldown', async () => {
    const api = mockApi([['POST', /resend-verification$/, () => json({ sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString() }, 202)]]);
    const user = userEvent.setup();
    render(makeRestaurant({ status: 'VERIFICATION_PENDING', emailVerification: { sentAt: '2026-10-01T00:00:00.000Z', expiresAt: null } }));
    expect(screen.getByText('Verify your business email')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change email' })).toHaveAttribute('href', '/restaurant/onboarding/r1?step=business');
    await user.click(screen.getByRole('button', { name: 'Resend email' }));
    await waitFor(() => expect(api.find('POST', /resend-verification$/)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /resend in/i })).toBeDisabled();
  });

  it('verification pending: honours a server rate limit', async () => {
    mockApi([['POST', /resend-verification$/, () => apiError(429, 'RATE_LIMITED', 'Please wait before requesting another email.')]]);
    const user = userEvent.setup();
    render(makeRestaurant({ status: 'VERIFICATION_PENDING' }));
    await user.click(screen.getByRole('button', { name: 'Resend email' }));
    expect(await screen.findByRole('button', { name: /resend in/i })).toBeDisabled();
  });

  it('awaiting approval links to the submission', () => {
    render(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(screen.getByText('Our team is reviewing your restaurant')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View submission' })).toHaveAttribute('href', '/restaurant/onboarding/r1?step=review');
  });

  it('rejected: shows the reason and links to edit and resubmit', () => {
    render(makeRestaurant({ status: 'REJECTED', statusReason: 'FSSAI licence is blurry' }));
    expect(screen.getByText('Your application needs changes')).toBeInTheDocument();
    expect(screen.getByText(/FSSAI licence is blurry/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit and resubmit' })).toHaveAttribute('href', '/restaurant/onboarding/r1?step=review');
  });

  it('suspended: shows the reason and contact support', () => {
    render(makeRestaurant({ status: 'SUSPENDED', statusReason: 'Hygiene complaint under review' }));
    expect(screen.getByText('Restaurant suspended')).toBeInTheDocument();
    expect(screen.getByText(/Hygiene complaint under review/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support?new=1');
  });

  it('draft says which step is next and links to the wizard; approved shows nothing unless paused', () => {
    const { unmount } = render(makeRestaurant({ status: 'DRAFT' }));
    expect(screen.getByText(/step 5 of 7 — documents/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/restaurant/onboarding/r1');
    unmount();
    const approved = render(makeRestaurant({ status: 'APPROVED' }));
    expect(approved.container).toBeEmptyDOMElement();
  });

  it('approved and paused: "Not accepting orders until …" with Resume now', async () => {
    const api = mockApi([['POST', /resume$/, () => json(makeRestaurant())]]);
    const user = userEvent.setup();
    render(makeRestaurant({ pausedUntil: new Date(Date.now() + 15 * 60_000).toISOString() }));
    expect(screen.getByText(/^Not accepting orders until/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(api.find('POST', /resume$/)).toHaveLength(1));
  });
});
