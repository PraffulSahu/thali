import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MenuPage from '../../src/features/restaurant/MenuPage';
import type { MenuCategory, OwnerItem } from '../../src/features/restaurant/api';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, json, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const cat: MenuCategory = { id: 'c1', restaurantId: 'r1', name: 'Mains', sortOrder: 10, active: true };
const item = (over: Partial<OwnerItem> = {}): OwnerItem => ({
  id: 'i1', restaurantId: 'r1', categoryId: 'c1', name: 'Chicken Biryani', description: '', pricePaise: 29900, isVeg: false, imageKey: null, imageUrl: null,
  available: true, trackStock: false, stockQty: 0, reservedQty: 0, availableQty: null, customizationGroups: [], tags: [], updatedAt: null, ...over,
});
const render = () => renderWithProviders(withRestaurant(makeRestaurant(), <MenuPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('MenuPage', () => {
  it('guides an owner with an empty menu to add a first category', async () => {
    mockApi([
      ['GET', /categories$/, { items: [] }],
      ['GET', /items$/, { items: [] }],
    ]);
    render();
    expect(await screen.findByText(/your menu is empty/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add item/i })).toBeDisabled();
  });

  it('toggles availability through the availability endpoint', async () => {
    const api = mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [item()] }],
      ['PATCH', /items\/i1\/availability$/, () => json(item({ available: false }))],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('switch', { name: /chicken biryani available/i }));
    await waitFor(() => expect(api.find('PATCH', /availability$/)).toHaveLength(1));
    expect(api.find('PATCH', /availability$/)[0]!.body).toEqual({ available: false });
  });

  it('updates tracked stock and shows what is held in open orders', async () => {
    const api = mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [item({ trackStock: true, stockQty: 10, reservedQty: 3, availableQty: 7 })] }],
      ['PATCH', /availability$/, () => json(item())],
    ]);
    const user = userEvent.setup();
    render();
    expect(await screen.findByText(/7 available, 3 held in open orders/i)).toBeInTheDocument();
    const stock = screen.getByLabelText(/stock for chicken biryani/i);
    await user.clear(stock);
    await user.type(stock, '25');
    await user.click(screen.getByRole('button', { name: /update stock/i }));
    await waitFor(() => expect(api.find('PATCH', /availability$/)).toHaveLength(1));
    expect(api.find('PATCH', /availability$/)[0]!.body).toEqual({ stockQty: 25 });
  });

  it('explains why a category cannot be deleted while it has items', async () => {
    mockApi([
      ['GET', /categories$/, { items: [cat] }],
      ['GET', /items$/, { items: [item()] }],
      ['DELETE', /categories\/c1$/, () => apiError(409, 'CONFLICT', 'Category has items')],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /delete category mains/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /delete category/i }));
    expect(await within(dialog).findByText(/still has items/i)).toBeInTheDocument();
  });

  it('creates a category', async () => {
    const api = mockApi([
      ['GET', /categories$/, { items: [] }],
      ['GET', /items$/, { items: [] }],
      ['POST', /categories$/, () => json({ ...cat, name: 'Starters' }, 201)],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /add your first category/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/category name/i), 'Starters');
    await user.click(within(dialog).getByRole('button', { name: /^add category$/i }));
    await waitFor(() => expect(api.find('POST', /categories$/)).toHaveLength(1));
    expect(api.find('POST', /categories$/)[0]!.body).toEqual({ name: 'Starters', active: true });
  });
});
