import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PartnerOnboarding from '../../src/features/partner/PartnerOnboarding';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, bodyOf, json, profile, routeFetch } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const draft = (over = {}) => profile({ status: 'DRAFT', online: false, vehicle: null, ...over });
const idDoc = { id: 'd1', type: 'ID_PROOF' as const, demoVerified: true, uploadedAt: '2026-10-10T10:00:00Z' };

describe('PartnerOnboarding wizard', () => {
  it('creates the profile (refreshing the user for DELIVERY_PARTNER), then saves the vehicle from option cards', async () => {
    let current: unknown = null;
    const fetchMock = routeFetch({
      'GET /partner/profile': () => (current ? json(200, current) : apiError(404, 'NOT_FOUND', 'Create your delivery partner profile first')),
      'POST /partner/profile': () => {
        current = draft();
        return json(201, current);
      },
      'PATCH /partner/profile': () => {
        current = draft({ vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' } });
        return json(200, current);
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuth({ roles: ['CONSUMER'] });
    (auth.refreshUser as ReturnType<typeof vi.fn>).mockResolvedValue(auth.user);
    renderWithProviders(<PartnerOnboarding />, { auth });

    expect(await screen.findByRole('heading', { level: 1, name: 'Become a delivery partner' })).toBeInTheDocument();
    const name = await screen.findByLabelText(/full name/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'Ravi Kumar');
    await userEvent.click(screen.getByRole('button', { name: /create profile & continue/i }));
    await waitFor(() => expect(auth.refreshUser).toHaveBeenCalled());
    expect(bodyOf(fetchMock, 'POST /partner/profile')).toEqual({ name: 'Ravi Kumar' });

    // Vehicle step
    await userEvent.click(await screen.findByRole('radio', { name: /scooter/i }));
    await userEvent.type(screen.getByLabelText(/registration number/i), 'ka05 mn4321');
    await userEvent.click(screen.getByRole('button', { name: /save & continue/i }));
    await waitFor(() => expect(bodyOf(fetchMock, 'PATCH /partner/profile')).toEqual({ vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' } }));
    // Documents step for a scooter: ID, licence and RC
    expect(await screen.findByRole('region', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText(/driving licence/i)).toBeInTheDocument();
    expect(screen.getByText(/vehicle registration certificate/i)).toBeInTheDocument();
  });

  it('uploads a document through presign → storage PUT → attach and labels demo checks', async () => {
    const withVehicle = draft({ vehicle: { type: 'BICYCLE', registrationNumber: 'FRAME1234' } });
    const fetchMock = routeFetch({
      'GET /partner/profile': () => json(200, withVehicle),
      'POST /partner/uploads': () => json(200, { key: 'partner-kyc/u1/ID_PROOF/x.png', upload: { url: 'https://s3.example/put', method: 'PUT', headers: { 'content-type': 'image/png' }, expiresAt: '', maxBytes: 5242880 } }),
      'PUT https://s3.example/put': () => new Response(null, { status: 200 }),
      'POST /partner/documents': () => json(200, { ...withVehicle, documents: [idDoc] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    const input = await screen.findByLabelText(/choose file: id proof/i);
    await userEvent.upload(input, new File(['abc'], 'id.png', { type: 'image/png' }));
    expect(await screen.findByText(/demo check only, not an approval/i)).toBeInTheDocument();
    expect(bodyOf(fetchMock, 'POST /partner/uploads')).toEqual({ type: 'ID_PROOF', contentType: 'image/png', sizeBytes: 3 });
    expect(bodyOf(fetchMock, 'POST /partner/documents')).toEqual({ type: 'ID_PROOF', key: 'partner-kyc/u1/ID_PROOF/x.png' });
  });

  it('rejects a wrong file type locally', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, draft({ vehicle: { type: 'BICYCLE', registrationNumber: 'FRAME1234' } })) }));
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    const input = await screen.findByLabelText(/choose file: id proof/i);
    await userEvent.upload(input, new File(['abc'], 'id.gif', { type: 'image/gif' }), { applyAccept: false });
    expect(await screen.findByText('Upload a JPG, PNG or PDF file.')).toBeInTheDocument();
  });

  it('rejected: banner with reason, review step lists missing items with Fix, and Resubmit posts /submit', async () => {
    const rejected = draft({ status: 'REJECTED', statusReason: 'Licence photo is blurry', vehicle: { type: 'BICYCLE', registrationNumber: 'FRAME1234' }, documents: [idDoc] });
    const fetchMock = routeFetch({
      'GET /partner/profile': () => json(200, rejected),
      'POST /partner/submit': () => json(200, { ...rejected, status: 'APPROVAL_PENDING', statusReason: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    expect(await screen.findByText('Your application wasn’t approved')).toBeInTheDocument();
    expect(screen.getByText(/licence photo is blurry/i)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Resubmit for review' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/partner/submit')).toBe(true));
    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();
  });

  it('review lists missing documents with Fix links and keeps submit disabled', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, draft({ vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' }, documents: [idDoc] })) }));
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: '4. Review & submit' }));
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
    const fixes = screen.getAllByRole('button', { name: 'Fix' });
    expect(fixes).toHaveLength(2); // licence + RC
    await userEvent.click(fixes[0]!);
    expect(await screen.findByRole('region', { name: 'Documents' })).toBeInTheDocument();
  });

  it('under review the vehicle is locked with the reason', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, draft({ status: 'APPROVAL_PENDING', vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' } })) }));
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: '2. Vehicle' }));
    expect(screen.getByRole('radio', { name: /scooter/i })).toBeDisabled();
    expect(screen.getByText(/locked while your application is under review/i)).toBeInTheDocument();
  });
});
