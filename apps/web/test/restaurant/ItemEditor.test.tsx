import '../setup';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemEditor } from '../../src/features/restaurant/ItemEditor';
import { validateGroups, type DraftGroup } from '../../src/features/restaurant/CustomizationEditor';
import type { MenuCategory, OwnerItem } from '../../src/features/restaurant/api';
import { makeAuth, renderWithProviders } from '../utils';
import { json, mockApi } from './fixtures';

const categories: MenuCategory[] = [{ id: 'c1', restaurantId: 'r1', name: 'Mains', sortOrder: 1, active: true }];
const item: OwnerItem = {
  id: 'i1', restaurantId: 'r1', categoryId: 'c1', name: 'Chicken Biryani', description: 'Dum cooked', pricePaise: 29900, isVeg: false,
  imageKey: null, imageUrl: null, available: true, trackStock: false, stockQty: 0, reservedQty: 0, availableQty: null,
  customizationGroups: [{ id: 'g1', name: 'Portion', minSelect: 1, maxSelect: 1, options: [{ id: 'o1', name: 'Half', pricePaise: 0, isVeg: false, available: true }, { id: 'o2', name: 'Full', pricePaise: 10000, isVeg: false, available: true }] }],
  tags: [], updatedAt: null,
};

const renderEditor = (props: Partial<Parameters<typeof ItemEditor>[0]> = {}) =>
  renderWithProviders(
    <ItemEditor open onClose={vi.fn()} restaurantId="r1" categories={categories} item={item} onSaved={vi.fn()} {...props} />,
    { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) },
  );

afterEach(() => vi.unstubAllGlobals());

describe('ItemEditor customization validation', () => {
  it('shows an error when minimum choices is greater than maximum, and does not save', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderEditor();

    const min = screen.getByLabelText('Group 1 minimum choices');
    const max = screen.getByLabelText('Group 1 maximum choices');
    fireEvent.change(max, { target: { value: '1' } });
    fireEvent.change(min, { target: { value: '3' } });

    expect(await screen.findByText(/minimum choices can't be more than the maximum/i)).toBeInTheDocument();
    expect(min).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/fix the highlighted fields/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('flags a maximum larger than the number of options', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Group 1 maximum choices'), { target: { value: '5' } });
    expect(await screen.findByText(/maximum can't be more than the number of options \(2\)/i)).toBeInTheDocument();
  });

  it('saves a valid item with money in paise and keeps existing group and option ids', async () => {
    const api = mockApi([['PATCH', /\/items\/i1$/, () => json({ ...item, pricePaise: 31900 })]]);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditor({ onSaved, onClose });

    const price = screen.getByLabelText(/^price/i);
    await user.clear(price);
    await user.type(price, '319');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const body = api.calls[0]!.body as Record<string, unknown>;
    expect(body.pricePaise).toBe(31900);
    expect(body.isVeg).toBe(false);
    expect(body.customizationGroups).toEqual([
      { id: 'g1', name: 'Portion', minSelect: 1, maxSelect: 1, options: [
        { id: 'o1', name: 'Half', pricePaise: 0, isVeg: false, available: true },
        { id: 'o2', name: 'Full', pricePaise: 10000, isVeg: false, available: true },
      ] },
    ]);
    expect(body).not.toHaveProperty('imageKey');
  });

  it('requires stock to be a whole number when stock tracking is on', async () => {
    const api = mockApi([]);
    const user = userEvent.setup();
    renderEditor({ item: undefined, defaultCategoryId: 'c1' });
    await user.type(screen.getByLabelText(/item name/i), 'Raita');
    await user.type(screen.getByLabelText(/^price/i), '60');
    await user.click(screen.getByRole('checkbox', { name: /track stock/i }));
    await user.clear(screen.getByLabelText(/units in stock/i));
    await user.type(screen.getByLabelText(/units in stock/i), 'abc');
    await user.click(screen.getByRole('button', { name: /add item/i }));
    expect(await screen.findByText(/whole number, 0 or more/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});

describe('ItemEditor photo preview', () => {
  it('releases local preview URLs when a photo is replaced and when the editor closes', async () => {
    let n = 0;
    const create = vi.fn(() => `blob:preview-${++n}`);
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    mockApi([
      ['POST', /\/uploads$/, () => json({ key: 'restaurants/r1/images/a.png', bucket: 'public', upload: { url: 'https://s3.test/a', method: 'PUT', headers: { 'content-type': 'image/png' }, expiresAt: 'x', maxBytes: 2097152 } }, 201)],
      ['PUT', /^\/a$/, () => new Response(null, { status: 200 })],
    ]);
    const user = userEvent.setup();
    const view = renderEditor();
    const input = screen.getByLabelText('Item photo');
    await user.upload(input, new File(['a'], 'a.png', { type: 'image/png' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await user.upload(input, new File(['b'], 'b.png', { type: 'image/png' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith('blob:preview-1');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:preview-2');
  });
});

describe('validateGroups', () => {
  const g = (over: Partial<DraftGroup> = {}): DraftGroup => ({
    name: 'Size', min: '1', max: '1',
    options: [{ name: 'S', price: '0', isVeg: true, available: true }, { name: 'L', price: '20', isVeg: true, available: true }],
    ...over,
  });
  it('accepts a valid group', () => expect(validateGroups([g()])).toEqual({}));
  it('rejects min > max', () => expect(validateGroups([g({ min: '2', max: '1' })])['g0.min']).toMatch(/can't be more than the maximum/));
  it('rejects max > options', () => expect(validateGroups([g({ max: '3' })])['g0.max']).toMatch(/number of options/));
  it('rejects max of 0, blank names and bad prices', () => {
    const e = validateGroups([g({ max: '0', name: ' ', options: [{ name: '', price: 'x', isVeg: true, available: true }] })]);
    expect(e['g0.max']).toBeDefined();
    expect(e['g0.name']).toBeDefined();
    expect(e['g0.o0.name']).toBeDefined();
    expect(e['g0.o0.price']).toBeDefined();
  });
  it('rejects a group with no options', () => expect(validateGroups([g({ options: [] })])['g0.options']).toBeDefined());
});
