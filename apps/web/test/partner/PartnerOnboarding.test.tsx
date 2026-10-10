import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerOnboarding from '../../src/features/partner/PartnerOnboarding';
import { makeAuth, renderWithProviders } from '../utils';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const created = { id: 'p1', userId: 'u1', name: 'Ravi Kumar', phone: null, vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' }, status: 'DRAFT', statusReason: null, documents: [], online: false, lastLocation: null, lastLocationAt: null, activeJobIds: [], maxActive: 2, isDemo: true, createdAt: null };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('PartnerOnboarding', () => {
  it('creates the profile and refreshes the user so DELIVERY_PARTNER is picked up', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/partner/profile')) return json(201, created);
      return json(404, { error: { code: 'NOT_FOUND', message: 'Create your delivery partner profile first', requestId: 'r' } });
    });
    const auth = makeAuth({ roles: ['CONSUMER'] });
    (auth.refreshUser as ReturnType<typeof vi.fn>).mockResolvedValue(auth.user);
    renderWithProviders(<PartnerOnboarding />, { auth });

    const nameInput = await screen.findByLabelText(/full name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Ravi Kumar');
    await userEvent.selectOptions(screen.getByLabelText(/vehicle type/i), 'SCOOTER');
    await userEvent.type(screen.getByLabelText(/registration number/i), 'ka05mn4321');
    await userEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(auth.refreshUser).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ name: 'Ravi Kumar', vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' } });
    expect((await screen.findAllByText(/driving licence/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /submit for review/i })).toBeDisabled();
  });

  it('uploads a document through presign, storage PUT and attach', async () => {
    const withDoc = { ...created, documents: [{ id: 'd1', type: 'ID_PROOF', demoVerified: true, uploadedAt: '2026-10-10T10:00:00Z' }] };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/partner/profile') && (!init?.method || init.method === 'GET')) return json(200, created);
      if (u.endsWith('/partner/uploads')) return json(200, { key: 'partner-kyc/u1/ID_PROOF/x.png', upload: { url: 'https://s3.example/put', method: 'PUT', headers: { 'content-type': 'image/png' }, expiresAt: '', maxBytes: 5242880 } });
      if (u === 'https://s3.example/put') return new Response(null, { status: 200 });
      if (u.endsWith('/partner/documents')) return json(200, withDoc);
      return json(500, { error: { code: 'INTERNAL', message: 'x', requestId: 'r' } });
    });
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    const input = (await screen.findAllByLabelText(/choose file/i))[0]!;
    await userEvent.upload(input, new File(['abc'], 'id.png', { type: 'image/png' }));

    expect(await screen.findByText(/demo check only/i)).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(expect.arrayContaining(['/api/v1/partner/uploads', 'https://s3.example/put', '/api/v1/partner/documents']));
    const presign = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/partner/uploads'))!;
    expect(JSON.parse(String((presign[1] as RequestInit).body))).toEqual({ type: 'ID_PROOF', contentType: 'image/png', sizeBytes: 3 });
  });

  it('locks vehicle fields while under review and PATCHes only the changed name', async () => {
    const pending = { ...created, status: 'APPROVAL_PENDING' };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return json(200, { ...pending, name: 'Ravi K' });
      return json(200, pending);
    });
    renderWithProviders(<PartnerOnboarding />, { auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    const nameInput = await screen.findByLabelText(/full name/i);
    expect(screen.getByLabelText(/vehicle type/i)).toBeDisabled();
    expect(screen.getByLabelText(/registration number/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save details/i })).toBeDisabled();
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Ravi K');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ name: 'Ravi K' });
  });
});
