/** Task 10 additions: featured items, pure veg, locality, settlement update, custom pause, PAY-1 window, helpers. */
import '../setup';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FinancePage from '../../src/features/restaurant/FinancePage';
import MenuPage from '../../src/features/restaurant/MenuPage';
import StoreSettingsPage from '../../src/features/restaurant/StoreSettingsPage';
import OnboardingWizard from '../../src/features/restaurant/OnboardingWizard';
import type { MenuCategory, OwnerItem } from '../../src/features/restaurant/api';
import { nextOpening } from '../../src/features/restaurant/hours';
import { defaultPrep, maskedPhone, optionText, partnerText, prepProgress, shortDuration } from '../../src/features/restaurant/orderText';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, json, makeRestaurant, mockApi, withRestaurant } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({
  MapView: ({ onPick }: { onPick?: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" data-testid="map" onClick={() => onPick?.({ lat: 12.97161, lng: 77.64061 })}>map</button>
  ),
}));

afterEach(() => vi.unstubAllGlobals());
const owner = () => makeAuth({ roles: ['RESTAURANT_OWNER'] });
const cat: MenuCategory = { id: 'c1', restaurantId: 'r1', name: 'Mains', sortOrder: 10, active: true };
const item = (over: Partial<OwnerItem> = {}): OwnerItem => ({
  id: 'i1', restaurantId: 'r1', categoryId: 'c1', name: 'Chicken Biryani', description: '', pricePaise: 29900, isVeg: false, imageKey: null, imageUrl: null,
  available: true, trackStock: false, stockQty: 0, reservedQty: 0, availableQty: null, customizationGroups: [], tags: [], featured: false, updatedAt: null, ...over,
});

describe('Menu: recommended (featured, max 6)', () => {
  it('stars an item via PATCH {featured:true} and shows the count', async () => {
    const api = mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [item()] }],
      ['PATCH', /items\/i1$/, () => json(item({ featured: true }))],
    ]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <MenuPage />), { auth: owner() });
    expect(await screen.findByText('0 of 6 recommended')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Recommend Chicken Biryani' }));
    await waitFor(() => expect(api.find('PATCH', /items\/i1$/)[0]?.body).toEqual({ featured: true }));
  });

  it('disables starring a 7th item and explains a server refusal', async () => {
    const six = Array.from({ length: 6 }, (_, i) => item({ id: `f${i}`, name: `Dish ${i}`, featured: true }));
    mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [...six, item({ id: 'i7', name: 'Seventh' })] }],
      ['PATCH', /items\/f0$/, () => apiError(400, 'VALIDATION_FAILED', 'At most 6 featured items')],
    ]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <MenuPage />), { auth: owner() });
    expect(await screen.findByRole('button', { name: 'Recommended is full (6)' })).toBeDisabled();
    expect(screen.getByText('6 of 6 recommended')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Dish 0 from recommended' }));
    expect(await screen.findByText(/recommend up to 6 items/i)).toBeInTheDocument();
  });

  it('highlights the item from ?item= (dashboard "Update stock") in its category', async () => {
    mockApi([
      ['GET', /categories$/, { items: [cat, { ...cat, id: 'c2', name: 'Desserts', sortOrder: 20 }] }],
      ['GET', /items$/, { items: [item(), item({ id: 'i9', categoryId: 'c2', name: 'Gulab Jamun', isVeg: true, trackStock: true, stockQty: 4, reservedQty: 1, availableQty: 3 })] }],
    ]);
    renderWithProviders(withRestaurant(makeRestaurant(), <MenuPage />), { route: '/restaurant/menu?item=i9', auth: owner() });
    expect(await screen.findByRole('region', { name: 'Desserts' })).toBeInTheDocument();
    expect(screen.getByLabelText('Stock for Gulab Jamun')).toBeInTheDocument();
  });
});

describe('Menu: pure-veg kitchen', () => {
  it('locks the item editor to vegetarian and explains a 422 PURE_VEG_VIOLATION', async () => {
    const api = mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [item({ isVeg: true, name: 'Paneer Tikka' })] }],
      ['PATCH', /items\/i1$/, () => apiError(422, 'PURE_VEG_VIOLATION', 'Non-veg not allowed', { itemId: 'i1' })],
    ]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant({ pureVeg: true }), <MenuPage />), { auth: owner() });
    expect(await screen.findByText('Pure veg')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Edit Paneer Tikka' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Non-vegetarian' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText(/pure-veg kitchen, so the item and all of its options must be vegetarian/i)).toBeInTheDocument();
    expect(api.find('PATCH', /items\/i1$/)[0]!.body).toMatchObject({ isVeg: true });
  });
});

describe('Store settings', () => {
  const render = (r = makeRestaurant({ address: { line1: '12 MG Road', locality: 'Ashok Nagar', city: 'Bengaluru', pincode: '560001' } })) =>
    renderWithProviders(withRestaurant(r, <StoreSettingsPage />), { auth: owner() });

  it('saves the locality inside the full address (MKT-5) and toggles pure veg', async () => {
    const api = mockApi([['PATCH', /\/owner\/restaurants\/r1$/, () => json(makeRestaurant())], ['GET', /items$/, { items: [] }]]);
    const user = userEvent.setup();
    render();
    const locality = screen.getByLabelText('Locality');
    await user.clear(locality);
    await user.type(locality, 'Indiranagar');
    await user.click(screen.getByRole('switch', { name: /pure veg kitchen/i }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.find('PATCH', /r1$/)).toHaveLength(1));
    expect(api.find('PATCH', /r1$/)[0]!.body).toEqual({
      address: { line1: '12 MG Road', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560001' },
      pureVeg: true,
    });
  });

  it('names the non-veg items that block pure veg (422)', async () => {
    mockApi([
      ['GET', /items$/, { items: [item({ id: 'i1', name: 'Chicken Biryani' }), item({ id: 'i2', name: 'Dal', isVeg: true })] }],
      ['PATCH', /\/owner\/restaurants\/r1$/, () => apiError(422, 'PURE_VEG_VIOLATION', 'Non-veg items exist', { itemIds: ['i1'], optionIds: [] })],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('switch', { name: /pure veg kitchen/i }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText(/still has non-veg items or options: Chicken Biryani/)).toBeInTheDocument();
  });

  it('pauses for a custom number of minutes', async () => {
    const api = mockApi([['POST', /pause$/, () => json(makeRestaurant({ pausedUntil: new Date(Date.now() + 90 * 60_000).toISOString() }))]]);
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    await user.type(screen.getByLabelText('Minutes'), '90');
    await user.click(screen.getByRole('button', { name: 'Pause for 90 min' }));
    await waitFor(() => expect(api.find('POST', /pause$/)[0]?.body).toEqual({ minutes: 90 }));
  });

  it('shows the settlement account masked and updates it (full number sent once)', async () => {
    const api = mockApi([['PUT', /settlement$/, () => json({ accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '9012' })]]);
    const user = userEvent.setup();
    render(makeRestaurant({ settlement: { accountHolder: 'Spice Route Foods', ifsc: 'HDFC0001234', last4: '4321' } }));
    expect(screen.getByText(/Account ending 4321/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await user.type(screen.getByLabelText(/^account number/i), '123456789012');
    await user.type(screen.getByLabelText(/confirm account number/i), '123456789012');
    await user.click(screen.getByRole('button', { name: 'Save bank account' }));
    await waitFor(() => expect(api.find('PUT', /settlement$/)[0]?.body).toEqual({ accountHolder: 'Spice Route Foods', accountNumber: '123456789012', ifsc: 'HDFC0001234' }));
    expect(screen.queryByText('123456789012')).not.toBeInTheDocument();
  });

  it('signs out of all devices after confirming', async () => {
    mockApi([]);
    const signOutEverywhere = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <StoreSettingsPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'], signOutEverywhere }) });
    await user.click(screen.getByRole('button', { name: 'Sign out of all devices' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(signOutEverywhere).toHaveBeenCalledTimes(1));
  });
});

describe('Finance: today window (PAY-1)', () => {
  it('asks for today in IST and shows window earnings next to the all-time tiles', async () => {
    const api = mockApi([
      ['GET', /summary$/, {
        accountType: 'RESTAURANT', accountId: 'r1', balancePaise: 1245000, availablePaise: 980000, pendingPayoutPaise: 0, paidOutPaise: 0, holdDays: 2,
        totalsByType: { ORDER_EARNING: 8000000, COMMISSION: -1440000 }, asOf: new Date().toISOString(),
        window: { from: new Date().toISOString(), to: new Date().toISOString(), earningsPaise: 815100, entriesByType: { ORDER_EARNING: 984200, COMMISSION: -177100 }, deliveries: 0 },
      }],
      ['GET', /ledger$/, { items: [], nextCursor: null }],
    ]);
    renderWithProviders(withRestaurant(makeRestaurant(), <FinancePage />), { auth: owner() });
    expect(await screen.findByText('Earned today')).toBeInTheDocument();
    expect(screen.getByText('₹8,151.00')).toBeInTheDocument();
    expect(screen.getByText('-₹1,771.00')).toBeInTheDocument();
    expect(screen.getByText('₹9,800.00')).toBeInTheDocument(); // available for payout
    const from = Date.parse(new URLSearchParams(api.find('GET', /summary$/)[0]!.search).get('from')!);
    expect((from + 330 * 60_000) % 86_400_000).toBe(0);
  });
});

describe('Onboarding: locality and pure veg', () => {
  it('location step sends the locality and pre-fills it from the map pin (reverse geocode)', async () => {
    const draft = makeRestaurant({ status: 'DRAFT', address: null, location: null });
    const api = mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, draft],
      ['GET', /^\/discovery\/reverse$/, { label: '100 Feet Rd, Indiranagar', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', serviceable: true, serviceArea: null, source: 'DEMO_GAZETTEER' }],
      ['PATCH', /^\/owner\/restaurants\/r1$/, () => json(draft)],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=location', path: '/restaurant/onboarding/:restaurantId', auth: owner() });
    await user.type(await screen.findByLabelText(/address line 1/i), '12, 100 Feet Rd');
    await user.click(await screen.findByTestId('map'));
    await waitFor(() => expect(screen.getByLabelText(/^locality/i)).toHaveValue('Indiranagar'));
    expect(screen.getByLabelText(/^city/i)).toHaveValue('Bengaluru');
    fireEvent.submit(screen.getByRole('button', { name: /save and continue/i }).closest('form')!);
    await waitFor(() => expect(api.find('PATCH', /r1$/)).toHaveLength(1));
    expect((api.find('PATCH', /r1$/)[0]!.body as { address: unknown }).address).toEqual({ line1: '12, 100 Feet Rd', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038' });
  });

  it('business step can declare a pure-veg kitchen', async () => {
    const r = makeRestaurant({ status: 'DRAFT' });
    const api = mockApi([
      ['GET', /^\/owner\/restaurants\/r1$/, r],
      ['GET', /^\/cuisines$/, { items: [{ id: 'c1', name: 'Biryani', slug: 'biryani' }] }],
      ['PATCH', /^\/owner\/restaurants\/r1$/, () => json(makeRestaurant({ status: 'DRAFT', pureVeg: true }))],
    ]);
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard />, { route: '/restaurant/onboarding/r1?step=business', path: '/restaurant/onboarding/:restaurantId', auth: owner() });
    await user.click(await screen.findByRole('switch', { name: /pure veg kitchen/i }));
    await user.click(screen.getByRole('button', { name: /save and continue/i }));
    await waitFor(() => expect(api.find('PATCH', /r1$/)[0]?.body).toMatchObject({ pureVeg: true }));
  });
});

describe('helpers', () => {
  it('option text, masked phone, default prep, durations', () => {
    expect(optionText({ addOns: [{ name: 'Full' }, { name: 'Extra raita' }] })).toBe('Full · Extra raita');
    expect(maskedPhone('+91******3210')).toBe('+91 ••••• •3210');
    expect(defaultPrep(15)).toBe(15);
    expect(defaultPrep(25)).toBe(20);
    expect(shortDuration(72)).toBe('1m 12s');
    expect(shortDuration(45)).toBe('45s');
  });

  it('prep progress from acceptedAt + readyEta, overdue after the promise', () => {
    const t0 = Date.parse('2026-10-11T10:00:00Z');
    const o = { acceptedAt: new Date(t0).toISOString(), readyEta: new Date(t0 + 20 * 60_000).toISOString(), prepMinutes: 20 };
    expect(prepProgress(o, t0 + 13 * 60_000 + 10_000)).toMatchObject({ elapsed: 13, total: 20, overdue: false, text: '13 of 20 min' });
    expect(prepProgress(o, t0 + 24 * 60_000)).toMatchObject({ overdue: true, text: '4 min over' });
    expect(prepProgress({ acceptedAt: null, readyEta: null, prepMinutes: 20 })).toBeNull();
  });

  it('partner line follows deliveryStatus', () => {
    expect(partnerText({ deliveryStatus: null })).toBe('Finding partner');
    expect(partnerText({ deliveryStatus: 'OFFERED' })).toBe('Finding partner');
    expect(partnerText({ deliveryStatus: 'ASSIGNED', partner: { name: 'Imran Khan', vehicleType: null } })).toBe('Imran assigned');
    expect(partnerText({ deliveryStatus: 'AT_PICKUP', partner: { name: 'Ravi', vehicleType: null } })).toBe('Ravi · at restaurant');
  });

  it('next opening time in IST', () => {
    // Saturday 2026-10-10 23:30 IST = 18:00Z; next slot Sunday 11:00 IST = 05:30Z
    const hours = [{ day: 0, open: '11:00', close: '23:00' }];
    expect(nextOpening(hours, Date.parse('2026-10-10T18:00:00Z'))?.toISOString()).toBe('2026-10-11T05:30:00.000Z');
    expect(nextOpening([], Date.now())).toBeNull();
  });
});
