import '../setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  AddressCard,
  Avatar,
  Badge,
  BillBreakdown,
  CartDock,
  CuisineCircle,
  EmptyState,
  EstBadge,
  EstLegend,
  FilterPill,
  KanbanColumn,
  KpiStrip,
  KpiTile,
  LiveIndicator,
  MapFrame,
  OptionCard,
  PhoneInput,
  PriceChips,
  ProgressBar,
  QtyStepper,
  RatingBadge,
  RestaurantCard,
  SegmentedTabs,
  StackedStatusBar,
  StatusPill,
  Stepper,
  ORDER_STEPS,
  Toggle,
  VegMark,
  PureVegBadge,
  hueFor,
  initials,
  nationalMobile,
  toE164India,
  formatMobileGroups,
  statusTone,
  statusLabel,
} from '../../src/components/ui';

const inRouter = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('status tones (design-spec §3.9 + overrides)', () => {
  it('applies the accepted tone changes', () => {
    expect(statusTone('delivery', 'PICKED_UP')).toBe('info');
    expect(statusTone('delivery', 'OUT_FOR_DELIVERY')).toBe('info');
    expect(statusTone('restaurant', 'APPROVAL_PENDING')).toBe('info');
    expect(statusTone('partner', 'APPROVAL_PENDING')).toBe('info');
    expect(statusLabel('health', 'up')).toBe('Up');
    expect(statusLabel('childOrder', 'SOMETHING_NEW')).toBe('Something new');
  });
  it('StatusPill renders the label with a dot', () => {
    render(<StatusPill kind="childOrder" status="REJECTED" density="dense" />);
    expect(screen.getByText('Rejected by restaurant')).toBeInTheDocument();
  });
  it('Badge accepts spec and legacy tone names', () => {
    render(
      <>
        <Badge tone="ok">A</Badge>
        <Badge tone="success">B</Badge>
      </>,
    );
    expect(screen.getByText('A').className).toBe(screen.getByText('B').className);
  });
});

describe('small marks', () => {
  it('VegMark / PureVegBadge / EstBadge are labelled for screen readers', () => {
    render(
      <>
        <VegMark veg />
        <VegMark veg={false} />
        <PureVegBadge />
        <span>
          32 min <EstBadge />
        </span>
        <EstLegend demo />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Veg' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Non-veg' })).toBeInTheDocument();
    expect(screen.getByText('Pure veg restaurant')).toBeInTheDocument();
    expect(screen.getByText('estimate')).toHaveClass('sr-only');
    expect(screen.getByText(/times are demo estimates/)).toBeInTheDocument();
  });

  it('RatingBadge shows "New" under 5 ratings, never stars', () => {
    const { rerender } = render(<RatingBadge avg={4.9} count={4} />);
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByText('★')).not.toBeInTheDocument();
    rerender(<RatingBadge avg={4.3} count={126} />);
    expect(screen.getByText(/4\.3/)).toBeInTheDocument();
    expect(screen.getByText(/\(126\)/)).toBeInTheDocument();
  });
});

describe('LiveIndicator', () => {
  it('renders nothing while connecting, the paused copy while polling, live text otherwise', () => {
    const { rerender, container } = render(<LiveIndicator status="connecting" />);
    expect(container.textContent).toBe('');
    rerender(<LiveIndicator status="polling" />);
    expect(screen.getByText('Live updates paused — refreshing every 10 s')).toBeInTheDocument();
    rerender(<LiveIndicator status="live" updatedAt={new Date(Date.now() - 12_000)} />);
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    expect(screen.getByText(/updated 12s ago/)).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  it('marks done / current / upcoming steps', () => {
    render(<Stepper label="Order progress" steps={[...ORDER_STEPS]} current={5} />);
    const list = screen.getByRole('list', { name: 'Order progress' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[5]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).toHaveTextContent('Placed (done)');
    expect(items[6]).toHaveTextContent('Delivered (upcoming)');
  });
  it('terminal state replaces the remaining steps with one bar', () => {
    render(<Stepper label="Order progress" steps={[...ORDER_STEPS]} current={2} terminal={{ label: 'Rejected by restaurant', tone: 'bad' }} />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent('Rejected by restaurant');
  });
});

describe('data display', () => {
  it('ProgressBar exposes progressbar semantics', () => {
    render(<ProgressBar value={13} max={20} label="Preparation" left="13 of 20 min" right="Finding partner" />);
    const bar = screen.getByRole('progressbar', { name: 'Preparation' });
    expect(bar).toHaveAttribute('aria-valuenow', '13');
    expect(bar).toHaveAttribute('aria-valuemax', '20');
  });

  it('KpiTile never shows zeros when unavailable and offers Retry', async () => {
    const onRetry = vi.fn();
    render(
      <KpiStrip label="Today">
        <KpiTile label="Orders" value="42" sub="51 child orders" />
        <KpiTile label="GMV" unavailable onRetry={onRetry} />
      </KpiStrip>,
    );
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('StackedStatusBar omits zero segments from the bar and hides "Failed" unless > 0', () => {
    render(
      <StackedStatusBar
        title="Child orders by status"
        segments={[
          { key: 'd', label: 'Delivered', count: 38, tone: 'ok' },
          { key: 'c', label: 'Cancelled', count: 0, tone: 'neu' },
          { key: 'f', label: 'Failed', count: 0, tone: 'neu', hideWhenZero: true },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Child orders by status: Delivered 38, Cancelled 0' })).toBeInTheDocument();
  });
});

describe('RestaurantCard', () => {
  it('links to the restaurant, shows New / meta / EST and no offer badge without an offer', () => {
    inRouter(
      <RestaurantCard to="/restaurants/green-leaf" id="r2" name="Green Leaf" cuisines={['South Indian', 'Healthy']} priceBand={1} rating={{ avg: 5, count: 2 }} etaMin={24} distanceKm={1.4} deliveryFeePaise={1900} pureVeg />,
    );
    const link = screen.getByRole('link', { name: /Green Leaf/ });
    expect(link).toHaveAttribute('href', '/restaurants/green-leaf');
    expect(within(link).getByText('New')).toBeInTheDocument();
    expect(within(link).getByText('South Indian · Healthy · ₹')).toBeInTheDocument();
    expect(within(link).getByText(/24 min est\./)).toBeInTheDocument();
    expect(within(link).getByText('₹19 delivery')).toBeInTheDocument();
    expect(within(link).queryByText(/OFF/)).not.toBeInTheDocument();
  });
  it('closed card shows the state badge and "Closed now"; offer only when provided', () => {
    inRouter(<RestaurantCard to="/r/t" id="r5" name="Tandoor Tales" open={false} stateLabel="Opens at 6:00 PM" offer={{ label: '20% OFF' }} />);
    expect(screen.getByText('Opens at 6:00 PM')).toBeInTheDocument();
    expect(screen.getByText('Closed now')).toBeInTheDocument();
    expect(screen.getByText('20% OFF')).toBeInTheDocument();
  });
  it('picks a stable identity hue', () => {
    expect(hueFor('abc')).toBe(hueFor('abc'));
  });
});

describe('CuisineCircle', () => {
  it('button variant is a toggle; link variant links; image wins over art', async () => {
    const onClick = vi.fn();
    inRouter(
      <>
        <CuisineCircle slug="biryani" label="Biryani" selected onClick={onClick} />
        <CuisineCircle variant="marketing" slug="pizza" label="Pizza" to="/?cuisine=pizza" imageUrl="/p.jpg" />
      </>,
    );
    const btn = screen.getByRole('button', { name: 'Biryani' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
    const link = screen.getByRole('link', { name: 'Pizza' });
    expect(link).toHaveAttribute('href', '/?cuisine=pizza');
    expect(link.querySelector('img')).toHaveAttribute('src', '/p.jpg');
  });
});

describe('CartDock', () => {
  const carts = [
    { id: 'a', name: 'Spice Route', hue: '#c2410c', subtotalPaise: 37800, itemCount: 2 },
    { id: 'b', name: 'Green Leaf', hue: '#15803d', subtotalPaise: 18000, itemCount: 1 },
  ];
  it('is hidden with an empty cart', () => {
    const { container } = inRouter(<CartDock carts={[]} itemCount={0} totalPaise={0} open={false} onOpenChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('summarises carts, toggles the tray and links to checkout', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <CartDock carts={carts} itemCount={3} totalPaise={55800} open={open} onOpenChange={setOpen} tray={<div>TRAY</div>} />;
    }
    inRouter(<Harness />);
    const summary = screen.getByRole('button', { name: /2 carts · 3 items/ });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2 deliveries, one payment')).toBeInTheDocument();
    expect(screen.getByText('Spice Route · ₹378')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Checkout · ₹558/ })).toHaveAttribute('href', '/checkout');
    await userEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('TRAY')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('TRAY')).not.toBeInTheDocument();
  });
});

describe('BillBreakdown', () => {
  it('opens the first restaurant, toggles others and renders discounts as −₹', async () => {
    render(
      <BillBreakdown
        totalPaise={64620}
        groups={[
          { id: 'a', name: 'Spice Route', totalPaise: 42810, rows: [{ label: 'Items', paise: 37800 }, { label: 'Coupon share', paise: -5000, discount: true }] },
          { id: 'b', name: 'Green Leaf', totalPaise: 21810, rows: [{ label: 'Items', paise: 18000 }] },
        ]}
      />,
    );
    expect(screen.getByText('2 deliveries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spice Route/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('−₹50.00')).toBeInTheDocument();
    const green = screen.getByRole('button', { name: /Green Leaf/ });
    expect(green).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(green);
    expect(green).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('₹646.20')).toBeInTheDocument();
  });
});

describe('forms', () => {
  it('AddressCard is a radio; a disabled reason disables it', async () => {
    const onSelect = vi.fn();
    render(
      <>
        <AddressCard name="addr" label="Home" address="12th Main, Indiranagar" isDefault checked={false} onSelect={onSelect} />
        <AddressCard name="addr" label="Office" address="Whitefield" checked={false} onSelect={vi.fn()} disabledReason="Outside delivery area" />
      </>,
    );
    await userEvent.click(screen.getByRole('radio', { name: /Home/ }));
    expect(onSelect).toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Office/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Office/ })).toHaveAccessibleDescription('Outside delivery area');
    expect(screen.getByText('DEFAULT')).toBeInTheDocument();
  });

  it('PhoneInput helpers normalise Indian mobiles', () => {
    expect(nationalMobile('+91 98765-43210')).toBe('9876543210');
    expect(nationalMobile('098765 43210')).toBe('9876543210');
    expect(nationalMobile('12345')).toBeNull();
    expect(toE164India('98765 43210')).toBe('+919876543210');
    expect(formatMobileGroups('9876543210')).toBe('98765 43210');
  });

  it('PhoneInput formats on blur', async () => {
    function H() {
      const [v, setV] = useState('');
      return <PhoneInput aria-label="Mobile number" value={v} onChange={setV} />;
    }
    render(<H />);
    const input = screen.getByLabelText('Mobile number');
    await userEvent.type(input, '9876543210');
    fireEvent.blur(input);
    expect(input).toHaveValue('98765 43210');
  });

  it('Toggle is a switch; FilterPill and PriceChips are pressed buttons', async () => {
    const onToggle = vi.fn();
    function Chips() {
      const [b, setB] = useState<number[]>([2]);
      return <PriceChips value={b} onChange={setB} />;
    }
    render(
      <>
        <Toggle checked={false} onChange={onToggle} label="Online" size="lg" />
        <FilterPill pressed veg>
          Veg only
        </FilterPill>
        <Chips />
      </>,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Online' }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: /Veg only/ })).toHaveAttribute('aria-pressed', 'true');
    const one = screen.getByRole('button', { name: 'Price band ₹' });
    expect(one).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(one);
    expect(one).toHaveAttribute('aria-pressed', 'true');
  });

  it('QtyStepper names its buttons after the item', async () => {
    const onChange = vi.fn();
    render(<QtyStepper value={1} onChange={onChange} itemName="Chicken Dum Biryani" />);
    await userEvent.click(screen.getByRole('button', { name: 'Add one Chicken Dum Biryani' }));
    expect(onChange).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Chicken Dum Biryani' }));
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('OptionCard wraps a real input; disabled shows "Unavailable"', () => {
    render(
      <>
        <OptionCard type="radio" name="size" label="Full" aside="₹249" checked onChange={() => {}} />
        <OptionCard type="checkbox" label="Boiled egg" aside="+₹20" disabled />
      </>,
    );
    expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Boiled egg · Unavailable/ })).toBeDisabled();
  });

  it('SegmentedTabs: pressed semantics + arrow keys', async () => {
    function H() {
      const [v, setV] = useState('customer');
      return (
        <SegmentedTabs
          label="Sign in as"
          value={v}
          onChange={setV}
          options={[
            { value: 'customer', label: 'Customer' },
            { value: 'restaurant', label: 'Restaurant' },
          ]}
        />
      );
    }
    render(<H />);
    expect(screen.getByRole('group', { name: 'Sign in as' })).toBeInTheDocument();
    const customer = screen.getByRole('button', { name: 'Customer' });
    expect(customer).toHaveAttribute('aria-pressed', 'true');
    customer.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Restaurant' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Restaurant' })).toHaveFocus();
  });
});

describe('misc', () => {
  it('Avatar: initials and image fallback', () => {
    expect(initials('Nisha Kapoor')).toBe('NK');
    expect(initials('Prafful')).toBe('P');
    expect(initials('')).toBe('?');
    const { container } = render(<Avatar name="Ravi Kumar" src="/broken.jpg" size={40} />);
    const img = container.querySelector('img')!;
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('R');
  });

  it('MapFrame shows SIMULATED LOCATION only when simulated', () => {
    const { rerender } = render(<MapFrame ariaLabel="Map. Location is simulated." simulated />);
    expect(screen.getByText('SIMULATED LOCATION')).toBeInTheDocument();
    rerender(<MapFrame ariaLabel="Map" />);
    expect(screen.queryByText('SIMULATED LOCATION')).not.toBeInTheDocument();
  });

  it('KanbanColumn shows its empty box when there are no cards', () => {
    render(<KanbanColumn title="New" count={0} empty={{ title: 'No new orders', sub: 'New orders appear here with a chime.' }} />);
    expect(screen.getByRole('region', { name: 'New, 0' })).toBeInTheDocument();
    expect(screen.getByText('No new orders')).toBeInTheDocument();
  });

  it('EmptyState renders title, body and action', () => {
    render(<EmptyState title="No restaurants match" description="Try fewer filters." action={<button type="button">Clear filters</button>} />);
    expect(screen.getByRole('heading', { name: 'No restaurants match' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});
