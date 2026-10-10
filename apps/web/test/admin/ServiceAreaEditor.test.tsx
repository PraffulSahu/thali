import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The Leaflet part is replaced by a stub exposing a fixed map centre, so the keyboard path is testable in jsdom.
vi.mock('../../src/features/admin/editors/PolygonMap', () => ({
  default: ({ centerRef }: { centerRef: { current: (() => { lat: number; lng: number }) | null } }) => {
    centerRef.current = () => ({ lat: 12.97, lng: 77.59 });
    return <div data-testid="map" />;
  },
}));

import ServiceAreaEditor from '../../src/features/admin/editors/ServiceAreaEditor';
import { makeAuth, renderWithProviders } from '../utils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('ServiceAreaEditor keyboard path', () => {
  it('adds corners without a mouse (map centre button + typed coordinates) and saves a closed ring', async () => {
    const user = userEvent.setup();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return Promise.resolve(json({ id: 'a1' }, 201)); }));
    renderWithProviders(<ServiceAreaEditor open item={null} onClose={() => undefined} />, { auth: makeAuth({ roles: ['ADMIN'], adminRoles: ['OPS'] }) });
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^name/i), 'Indiranagar');
    await user.type(within(dialog).getByLabelText(/base fee/i), '30');
    await user.type(within(dialog).getByLabelText(/base distance/i), '3');
    await user.type(within(dialog).getByLabelText(/per extra km/i), '8');
    await user.type(within(dialog).getByLabelText(/maximum fee/i), '90');

    await user.click(await within(dialog).findByRole('button', { name: /add corner at map centre/i }));
    expect(within(dialog).getByRole('status')).toHaveTextContent(/1 corner/);

    // invalid coordinates are refused with a message
    await user.type(within(dialog).getByLabelText(/corner latitude/i), '95');
    await user.type(within(dialog).getByLabelText(/corner longitude/i), '77.6');
    await user.click(within(dialog).getByRole('button', { name: /^add corner$/i }));
    expect(within(dialog).getByText(/latitude between -90 and 90/i)).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText(/corner latitude/i));
    await user.type(within(dialog).getByLabelText(/corner latitude/i), '12.98');
    await user.click(within(dialog).getByRole('button', { name: /^add corner$/i }));
    // Enter in the longitude field adds a corner instead of submitting the form
    await user.type(within(dialog).getByLabelText(/corner latitude/i), '12.96');
    await user.type(within(dialog).getByLabelText(/corner longitude/i), '77.61{Enter}');
    expect(within(dialog).getByRole('status')).toHaveTextContent(/3 corners/);
    expect(calls).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: /add service area/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(String(calls[0]!.init?.body));
    const ring = body.polygon.coordinates[0];
    expect(ring).toHaveLength(4);
    expect(ring[3]).toEqual(ring[0]);
    expect(ring[0]).toEqual([77.59, 12.97]);
    expect(body.deliveryFee).toEqual({ basePaise: 3000, baseKm: 3, perKmPaise: 800, maxPaise: 9000 });
  });
});
