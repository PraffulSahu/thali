import '../setup';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../../src/features/consumer/api';
import { ItemCustomizer } from '../../src/features/consumer/ItemCustomizer';
import { renderWithProviders } from '../utils';

const item: MenuItem = {
  id: 'item1',
  restaurantId: 'r1',
  categoryId: 'cat1',
  name: 'Veg Thali',
  description: 'Rice, dal, sabzi',
  pricePaise: 20000,
  isVeg: true,
  imageUrl: null,
  available: true,
  tags: [],
  customizationGroups: [
    {
      id: 'g-size',
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: 'o-reg', name: 'Regular', pricePaise: 0, isVeg: true, available: true },
        { id: 'o-lg', name: 'Large', pricePaise: 5000, isVeg: true, available: true },
      ],
    },
    {
      id: 'g-add',
      name: 'Add-ons',
      minSelect: 0,
      maxSelect: 2,
      options: [
        { id: 'a1', name: 'Papad', pricePaise: 1000, isVeg: true, available: true },
        { id: 'a2', name: 'Raita', pricePaise: 2000, isVeg: true, available: true },
        { id: 'a3', name: 'Sweet', pricePaise: 3000, isVeg: true, available: true },
        { id: 'a4', name: 'Pickle', pricePaise: 500, isVeg: true, available: false },
      ],
    },
  ],
};

describe('ItemCustomizer', () => {
  it('disables Add until the required group is satisfied', async () => {
    const onAdd = vi.fn();
    renderWithProviders(<ItemCustomizer item={item} open onClose={() => undefined} onAdd={onAdd} />);
    const add = screen.getByRole('button', { name: /add to cart/i });
    expect(add).toBeDisabled();
    expect(screen.getByText(/choose 1 option in size/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /large/i }));
    expect(add).toBeEnabled();
    expect(add).toHaveTextContent('₹250');
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith({ selections: [{ groupId: 'g-size', optionIds: ['o-lg'] }], quantity: 1, note: undefined });
  });

  it('enforces maxSelect and blocks unavailable options', async () => {
    renderWithProviders(<ItemCustomizer item={item} open onClose={() => undefined} onAdd={() => undefined} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /papad/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /raita/i }));
    expect(screen.getByRole('checkbox', { name: /sweet/i })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /pickle/i })).toBeDisabled();
    expect(screen.getByText(/maximum 2 selected/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /papad/i }));
    expect(screen.getByRole('checkbox', { name: /sweet/i })).toBeEnabled();
  });
});
