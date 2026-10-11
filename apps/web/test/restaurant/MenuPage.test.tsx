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
    expect(await screen.findByText('7 left · 3 reserved')).toBeInTheDocument();
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
    expect(api.find('POST', /categories$/)[0]!.body).toEqual({ name: 'Starters', active: true, sortOrder: 10 });
  });
});

describe('MenuPage category order', () => {
  const c = (id: string, name: string, sortOrder: number): MenuCategory => ({ id, restaurantId: 'r1', name, sortOrder, active: true });
  const setup = (cats: MenuCategory[]) =>
    mockApi([
      ['GET', /categories$/, { items: cats }],
      ['GET', /items$/, { items: [] }],
      ['PATCH', /categories\/[^/]+$/, () => json(cats[0])],
      ['POST', /categories$/, () => json(cats[0], 201)],
    ]);
  const patches = (api: ReturnType<typeof mockApi>) =>
    api.find('PATCH', /categories\/[^/]+$/).map((p) => [p.path.split('/').pop(), (p.body as { sortOrder: number }).sortOrder]).sort();

  it('renumbers the whole list (10, 20, 30...) when tied sort orders are reordered', async () => {
    const api = setup([c('a', 'Starters', 0), c('b', 'Mains', 0), c('c', 'Desserts', 0)]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Move Mains up' }));
    await waitFor(() => expect(api.find('PATCH', /categories\//)).toHaveLength(3));
    // list was shown alphabetically by name for ties: Desserts, Mains, Starters; Mains moves above Desserts
    expect(patches(api)).toEqual([['a', 30], ['b', 10], ['c', 20]]);
  });

  it('only rewrites the categories whose position changed when the numbering is already clean', async () => {
    const api = setup([c('a', 'Starters', 10), c('b', 'Mains', 20), c('c', 'Desserts', 30)]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Move Desserts up' }));
    await waitFor(() => expect(api.find('PATCH', /categories\//)).toHaveLength(2));
    expect(patches(api)).toEqual([['b', 30], ['c', 20]]);
  });

  it('appends a new category at the end of the numbering', async () => {
    const api = setup([c('a', 'Starters', 10), c('b', 'Mains', 20), c('c', 'Desserts', 30)]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/category name/i), 'Drinks');
    await user.click(within(dialog).getByRole('button', { name: /^add category$/i }));
    await waitFor(() => expect(api.find('POST', /categories$/)).toHaveLength(1));
    expect(api.find('POST', /categories$/)[0]!.body).toEqual({ name: 'Drinks', active: true, sortOrder: 40 });
  });
});
