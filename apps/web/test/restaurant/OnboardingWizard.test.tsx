import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnboardingWizard from '../../src/features/restaurant/OnboardingWizard';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, completeDraft, json, makeRestaurant, mockApi } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({
  MapView: ({ onPick }: { onPick?: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" data-testid="map" onClick={() => onPick?.({ lat: 12.97161, lng: 77.59461 })}>map</button>
  ),
}));

const CUISINES = { items: [{ id: 'c1', name: 'Biryani', slug: 'biryani', imageUrl: null, sortOrder: 1 }, { id: 'c2', name: 'North Indian', slug: 'north-indian', imageUrl: null, sortOrder: 2 }] };
const ROUTE = { path: '/restaurant/onboarding/:restaurantId' };

afterEach(() => vi.unstubAllGlobals());

describe('OnboardingWizard: creating', () => {
  it('blocks "Create restaurant" until required fields are filled and does not call the API', async () => {
    const api = mockApi([['GET', /^\/cuisines$/, CUISINES]]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding', path: '/restaurant/onboarding', auth: makeAuth({ roles: ['CONSUMER'] }) });

    await user.click(await screen.findByRole('button', { name: /create restaurant and continue/i }));

    expect(await screen.findByText('Enter the registered business name.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one cuisine.')).toBeInTheDocument();
    expect(screen.getByText('Enter your business email.')).toBeInTheDocument();
    expect(api.find('POST', /owner\/restaurants/)).toHaveLength(0);
  });

  it('creates the restaurant, refreshes the session for the new owner role, then moves to the location step', async () => {
    const created = makeRestaurant({ status: 'DRAFT' });
    const api = mockApi([
      ['GET', /^\/cuisines$/, CUISINES],
      ['POST', /^\/owner\/restaurants$/, () => json({ restaurant: created, roleGranted: true }, 201)],
    ]);
    const refreshUser = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { router } = renderWithProviders(<OnboardingWizard />, {
      route: '/restaurant/onboarding',
      path: '/restaurant/onboarding',
      auth: makeAuth({ roles: ['CONSUMER'], refreshUser }),
    });

    await user.type(await screen.findByLabelText(/registered business name/i), 'Spice Route Foods Pvt Ltd');
    await user.type(screen.getByLabelText(/^restaurant name/i), 'Spice Route');
    await user.type(screen.getByLabelText(/^description/i), 'Hyderabadi biryani and kebabs');
    await user.click(await screen.findByRole('checkbox', { name: 'Biryani' }));
    await user.type(screen.getByLabelText(/phone number/i), '98765 43210');
    await user.type(screen.getByLabelText(/business email/i), 'Owner@SpiceRoute.test');
    await user.click(screen.getByRole('button', { name: /create restaurant and continue/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/restaurant/onboarding/r1'));
    expect(router.state.location.search).toBe('?step=location');
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(api.find('POST', /^\/owner\/restaurants$/)[0]!.body).toEqual({
      businessName: 'Spice Route Foods Pvt Ltd',
      name: 'Spice Route',
      description: 'Hyderabadi biryani and kebabs',
      cuisines: ['biryani'],
      phone: '+919876543210',
      businessEmail: 'owner@spiceroute.test',
    });
  });
});

describe('OnboardingWizard: review and submit', () => {
  it('blocks submit until required fields are complete and lists what is missing', async () => {
    const api = mockApi([['GET', /^\/owner\/restaurants\/r1$/, makeRestaurant({ status: 'DRAFT' })]]);
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=review', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

    const submit = await screen.findByRole('button', { name: /submit for review/i });
    expect(submit).toBeDisabled();
    const missing = screen.getByText(/complete these before submitting/i).closest('div')!;
    expect(within(missing).getByText('FSSAI licence')).toBeInTheDocument();
    expect(within(missing).getByText('Settlement bank details')).toBeInTheDocument();
    await userEvent.click(submit);
    expect(api.find('POST', /submit/)).toHaveLength(0);
  });

  it('shows the verification-pending banner (with resend + cooldown) after a successful submit', async () => {
    const pending = completeDraft({
      status: 'VERIFICATION_PENDING',
      emailVerification: { sentAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    const api = mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, completeDraft()],
      ['POST', /^\/owner\/restaurants\/r1\/submit$/, pending],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=review', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

    const submit = await screen.findByRole('button', { name: /submit for review/i });
    expect(submit).toBeEnabled();
    expect(screen.queryByText(/verify your business email/i)).not.toBeInTheDocument();
    await user.click(submit);

    expect(await screen.findByText('Verify your business email')).toBeInTheDocument();
    expect(screen.getByText('owner@spiceroute.test')).toBeInTheDocument();
    expect(api.find('POST', /submit/)).toHaveLength(1);
    // the server sent the email just now: resend is on cooldown
    expect(screen.getByRole('button', { name: /resend in \d:\d\d/i })).toBeDisabled();
  });

  it('shows the server-side missing fields when the API rejects the submit', async () => {
    mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, completeDraft()],
      ['POST', /submit$/, () => apiError(422, 'VALIDATION_FAILED', 'Complete these fields before submitting: documents.TRADE_LICENSE', { missing: ['documents.TRADE_LICENSE'] })],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=review', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    await user.click(await screen.findByRole('button', { name: /submit for review/i }));
    expect(await screen.findByText(/documents\.TRADE_LICENSE/)).toBeInTheDocument();
  });

  it('shows the email-verification outcome from the redirect link', async () => {
    mockApi([]);
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding?emailVerified=0&reason=expired', path: '/restaurant/onboarding', auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    expect(await screen.findByText(/verification link has expired/i)).toBeInTheDocument();
  });
});

describe('OnboardingWizard: uploads', () => {
  it('documents: presigns with the declared size, PUTs with the signed headers, then attaches', async () => {
    const attached = { id: 'd1', type: 'FSSAI', key: 'restaurants/r1/documents/abc.pdf', verified: false, uploadedAt: '2026-10-10T00:00:00.000Z' };
    const api = mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, makeRestaurant({ status: 'DRAFT' })],
      ['POST', /\/uploads$/, () => json({ key: 'restaurants/r1/documents/abc.pdf', bucket: 'private', upload: { url: 'https://s3.test/bucket/abc.pdf?sig=1', method: 'PUT', headers: { 'content-type': 'application/pdf', 'content-length': '11' }, expiresAt: 'x', maxBytes: 5242880 } }, 201)],
      ['PUT', /s3\.test|bucket/, () => new Response(null, { status: 200 })],
      ['POST', /\/documents$/, () => json(attached, 201)],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=documents', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

    const input = await screen.findByLabelText('FSSAI licence');
    await user.upload(input, new File(['hello world'], 'fssai.pdf', { type: 'application/pdf' }));

    expect(await screen.findByText(/FSSAI licence uploaded/i)).toBeInTheDocument();
    const presign = api.find('POST', /\/uploads$/)[0]!;
    expect(presign.body).toEqual({ purpose: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: 11 });
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['content-type']).toBe('application/pdf');
    expect(api.find('POST', /\/documents$/)[0]!.body).toEqual({ type: 'FSSAI', key: 'restaurants/r1/documents/abc.pdf' });
  });

  it('rejects a wrong file type on the client before any request is made', async () => {
    const api = mockApi([['GET', /^\/owner\/restaurants\/r1$/, makeRestaurant({ status: 'DRAFT' })]]);
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=documents', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    await user.upload(await screen.findByLabelText('GST certificate'), new File(['x'], 'gst.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByText(/isn't allowed/i)).toBeInTheDocument();
    expect(api.find('POST', /uploads/)).toHaveLength(0);
  });
});

describe('OnboardingWizard: settlement', () => {
  it('sends the full account number once, then only the last 4 digits are ever rendered', async () => {
    const api = mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, completeDraft({ settlement: null })],
      ['PUT', /settlement$/, () => json({ accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '9012' })],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=settlement', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

    await user.type(await screen.findByLabelText(/account holder name/i), 'Spice Route Foods');
    await user.type(screen.getByLabelText(/^account number/i), '123456789012');
    await user.type(screen.getByLabelText(/confirm account number/i), '123456789012');
    await user.type(screen.getByLabelText(/ifsc/i), 'hdfc0001234');
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    // moved on to the review step, which only knows the masked value
    expect(await screen.findByText(/Spice Route Foods · ending 9012/)).toBeInTheDocument();
    expect(api.find('PUT', /settlement$/)[0]!.body).toEqual({ accountHolder: 'Spice Route Foods', accountNumber: '123456789012', ifsc: 'HDFC0001234' });
    expect(document.body.textContent).not.toContain('123456789012');
    expect(document.body.textContent).not.toContain('3456789012');
    expect(Array.from(document.querySelectorAll('input')).some((i) => i.value.includes('123456789012'))).toBe(false);
  });

  it('shows an already-saved account as masked and lets the owner keep it', async () => {
    mockApi([['GET', /^\/owner\/restaurants\/r1$/, completeDraft()]]);
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=settlement', ...ROUTE, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    expect(await screen.findByText(/Account ending 4321/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^account number/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep these details/i })).toBeInTheDocument();
  });
});
