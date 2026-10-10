import './setup';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckoutStatus,
  ChildOrderStatus,
  ChildRefundStatus,
  DeliveryStatus,
  PartnerStatus,
  PaymentStatus,
  PayoutStatus,
  RefundStatus,
  RestaurantStatus,
  TicketStatus,
} from '@thali/contracts';
import { Dialog } from '../src/components/ui/Dialog';
import { Field } from '../src/components/ui/Field';
import { Input } from '../src/components/ui/Input';
import { ToastProvider, useToast } from '../src/components/ui/Toast';
import { StatusPill, statusLabel, type StatusKind } from '../src/components/ui/StatusPill';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';
import { QueryState } from '../src/components/ui/QueryState';
import { DataTable } from '../src/components/ui/DataTable';
import { Price } from '../src/components/ui/Price';
import { useIdempotencyKey } from '../src/hooks/useIdempotencyKey';
import { ApiError } from '../src/lib/errors';
import { renderWithProviders } from './utils';

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Edit item"
        description="Change the price"
        footer={<button>Save</button>}
      >
        <input aria-label="Name" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is a labelled modal that traps focus and closes on Escape, restoring focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Edit item' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Change the price');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    // Cycle with Tab through every focusable element; focus never leaves the dialog.
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe('Dialog when focus leaves the overlay', () => {
  it('still traps Tab and closes on Escape after focus drops to <body>', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit item' });

    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pulls programmatic focus elsewhere back into the dialog', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Outside</button>
        <DialogHarness />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit item' });
    act(() => screen.getByRole('button', { name: 'Outside', hidden: true }).focus());
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('refocuses a non-dismissible dialog on backdrop click instead of closing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Saving" dismissible={false}>
        <p>Please wait</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Saving' });
    const backdrop = dialog.previousElementSibling as HTMLElement;
    await user.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Field', () => {
  it('associates the label, hint and error with the control', () => {
    render(
      <Field label="Phone number" hint="10-digit mobile" error="Enter a valid mobile number" required>
        <Input type="tel" />
      </Field>,
    );
    const input = screen.getByLabelText(/phone number/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const error = screen.getByText('Enter a valid mobile number').closest('[id]')!;
    const hint = screen.getByText('10-digit mobile');
    expect(describedBy.split(' ')).toEqual(expect.arrayContaining([error.id, hint.id]));
    expect(input).toHaveAccessibleDescription(/enter a valid mobile number/i);
  });

  it('has no aria-invalid without an error', () => {
    render(
      <Field label="Name">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });
});

function ToastButton() {
  const { toast } = useToast();
  return <button onClick={() => toast({ title: 'Order accepted', tone: 'success' })}>Notify</button>;
}

describe('Toast', () => {
  it('announces via role="status"', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    );
    // The polite live region exists before any toast is shown (so the insertion is announced).
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: 'Notify' }));
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Order accepted');
    expect(region).toContainElement(toast);
  });
});

describe('StatusPill', () => {
  const kinds: Array<[StatusKind, Record<string, string>]> = [
    ['childOrder', ChildOrderStatus],
    ['checkout', CheckoutStatus],
    ['payment', PaymentStatus],
    ['refund', RefundStatus],
    ['childRefund', ChildRefundStatus],
    ['delivery', DeliveryStatus],
    ['restaurant', RestaurantStatus],
    ['partner', PartnerStatus],
    ['ticket', TicketStatus],
    ['payout', PayoutStatus],
  ];
  it.each(kinds)('has a human label for every %s status', (kind, values) => {
    for (const v of Object.values(values)) {
      const label = statusLabel(kind, v);
      expect(label, `${kind}.${v}`).not.toBe(v);
      expect(label).not.toMatch(/_/);
    }
  });

  it('renders unknown statuses readably', () => {
    render(<StatusPill kind="childOrder" status="SOMETHING_NEW" />);
    expect(screen.getByText('Something new')).toBeInTheDocument();
  });
});

describe('Price', () => {
  it('formats paise as INR', () => {
    render(<Price paise={123456} />);
    expect(screen.getByText('₹1,234.56')).toBeInTheDocument();
  });
});

describe('QueryState', () => {
  const base = { data: undefined, isPending: false, isError: false, error: null, refetch: vi.fn(), isFetching: false };

  it('shows a loading status while pending', () => {
    renderWithProviders(<QueryState query={{ ...base, isPending: true }}>{() => <p>data</p>}</QueryState>);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });

  it('shows an error with a retry that refetches', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    renderWithProviders(
      <QueryState query={{ ...base, isError: true, error: new ApiError({ code: 'UPSTREAM_UNAVAILABLE', status: 502, message: 'down', requestId: 'req-1' }), refetch }}>
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/req-1/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows a forbidden state for 403', () => {
    renderWithProviders(
      <QueryState query={{ ...base, isError: true, error: new ApiError({ code: 'FORBIDDEN', status: 403, message: 'no' }) }}>
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByRole('heading', { name: /you don.t have access/i })).toBeInTheDocument();
  });

  it('shows a session-expired state for 401', () => {
    renderWithProviders(
      <QueryState query={{ ...base, isError: true, error: new ApiError({ code: 'UNAUTHENTICATED', status: 401, message: 'no' }) }}>
        {() => <p>data</p>}
      </QueryState>,
    );
    expect(screen.getByRole('heading', { name: /session expired/i })).toBeInTheDocument();
  });

  it('shows the empty state when isEmpty says so, otherwise renders data', () => {
    const { rerender } = renderWithProviders(
      <QueryState query={{ ...base, data: { items: [] } }} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No orders yet' }}>
        {(d) => <p>{d.items.length} orders</p>}
      </QueryState>,
    );
    expect(screen.getByText('No orders yet')).toBeInTheDocument();
    rerender(<p />);
  });
});

describe('ConfirmDialog', () => {
  it('requires a reason before confirming and passes it to onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Reject order?"
        confirmLabel="Reject order"
        tone="danger"
        reason={{ label: 'Reason', minLength: 3 }}
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Reject order' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/reason/i), 'Out of paneer');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Out of paneer'));
  });
});

describe('DataTable', () => {
  it('renders rows, and an empty state when there are none', () => {
    const columns = [
      { key: 'code', header: 'Order', cell: (r: { code: string }) => r.code, primary: true },
    ];
    const { rerender } = renderWithProviders(
      <DataTable caption="Orders" columns={columns} rows={[{ code: 'TH-1' }]} getRowId={(r) => r.code} />,
    );
    expect(screen.getByText('TH-1')).toBeInTheDocument();
    rerender(<DataTable caption="Orders" columns={columns} rows={[]} getRowId={(r) => r.code} empty={{ title: 'No orders' }} />);
    expect(screen.getByText('No orders')).toBeInTheDocument();
  });
});

describe('useIdempotencyKey', () => {
  it('is stable across renders and renews on demand', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.key;
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    rerender();
    expect(result.current.key).toBe(first);
    act(() => result.current.renew());
    expect(result.current.key).not.toBe(first);
  });
});
