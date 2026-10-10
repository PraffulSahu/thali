import '../setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountdownRing, ringProgress } from '../../src/components/ui/CountdownRing';
import { CodeDigits, CodeEntry, OtpInput } from '../../src/components/ui/CodeDigits';

afterEach(() => vi.useRealTimers());

describe('CountdownRing', () => {
  it('computes the dash offset from remaining / total', () => {
    expect(ringProgress(150.8, 300, 300)).toBeCloseTo(0);
    expect(ringProgress(150.8, 150, 300)).toBeCloseTo(75.4);
    expect(ringProgress(150.8, 0, 300)).toBeCloseTo(150.8);
    expect(ringProgress(150.8, 400, 300)).toBeCloseTo(0); // clamped
  });

  it('accept variant: m:ss text, sentence label, turns danger at 60 s and fires onExpire once', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    const onExpire = vi.fn();
    const to = new Date('2026-10-11T10:04:01Z').toISOString();
    render(<CountdownRing to={to} totalSec={300} variant="accept" label="left to accept" onExpire={onExpire} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('4:01');
    expect(timer).toHaveAccessibleName('4 minutes 1 second left to accept');
    expect(timer).toHaveAttribute('data-danger', 'false');

    act(() => vi.advanceTimersByTime(181_000)); // 60 s left
    expect(screen.getByRole('timer')).toHaveTextContent('1:00');
    expect(screen.getByRole('timer')).toHaveAttribute('data-danger', 'true');

    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByRole('timer')).toHaveTextContent('0:00');
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('offer variant shows seconds and is urgent at 10 s', () => {
    render(<CountdownRing secondsLeft={11} totalSec={45} variant="offer" label="to accept the offer" />);
    expect(screen.getByRole('timer')).toHaveTextContent(/^11$/);
    expect(screen.getByRole('timer')).toHaveAttribute('data-danger', 'false');
  });

  it('offer variant danger threshold', () => {
    render(<CountdownRing secondsLeft={10} totalSec={45} variant="offer" label="to accept the offer" />);
    expect(screen.getByRole('timer')).toHaveAttribute('data-danger', 'true');
    expect(screen.getByRole('timer')).toHaveAccessibleName('10 seconds to accept the offer');
  });
});

describe('CodeDigits', () => {
  it('renders one box per digit with a spelled-out group label', () => {
    render(<CodeDigits code="4719" label="Delivery code" />);
    expect(screen.getByRole('group', { name: 'Delivery code 4 7 1 9' })).toBeInTheDocument();
    expect(screen.getAllByText(/^\d$/)).toHaveLength(4);
  });
});

function EntryHarness({ onComplete }: { onComplete?: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <>
      <CodeEntry length={4} value={v} onChange={setV} onComplete={onComplete} label="Customer's delivery code" />
      <output data-testid="v">{v}</output>
    </>
  );
}

describe('CodeEntry', () => {
  it('auto-advances while typing and completes on the last digit', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<EntryHarness onComplete={onComplete} />);
    await user.click(screen.getByLabelText('Digit 1'));
    await user.keyboard('47');
    expect(screen.getByLabelText('Digit 3')).toHaveFocus();
    await user.keyboard('19');
    expect(screen.getByTestId('v')).toHaveTextContent('4719');
    expect(onComplete).toHaveBeenCalledWith('4719');
  });

  it('ignores non-digits', async () => {
    const user = userEvent.setup();
    render(<EntryHarness />);
    await user.click(screen.getByLabelText('Digit 1'));
    await user.keyboard('a4');
    expect(screen.getByTestId('v')).toHaveTextContent(/^4$/);
  });

  it('backspace on an empty box clears the previous one and moves back', async () => {
    const user = userEvent.setup();
    render(<EntryHarness />);
    await user.click(screen.getByLabelText('Digit 1'));
    await user.keyboard('47');
    expect(screen.getByLabelText('Digit 3')).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(screen.getByLabelText('Digit 2')).toHaveFocus();
    expect(screen.getByTestId('v')).toHaveTextContent(/^4$/);
  });

  it('paste fills every box', async () => {
    const onComplete = vi.fn();
    render(<EntryHarness onComplete={onComplete} />);
    fireEvent.paste(screen.getByLabelText('Digit 1'), { clipboardData: { getData: () => ' 4 7-1 9 ' } });
    expect(screen.getByTestId('v')).toHaveTextContent('4719');
    expect(onComplete).toHaveBeenCalledWith('4719');
  });
});

function OtpHarness({ onComplete }: { onComplete?: (v: string) => void }) {
  const [v, setV] = useState('');
  return <OtpInput value={v} onChange={setV} onComplete={onComplete} label="6-digit code" />;
}

describe('OtpInput', () => {
  it('is one labelled input (SMS autofill) that strips non-digits and completes at 6', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<OtpHarness onComplete={onComplete} />);
    const input = screen.getByLabelText('6-digit code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(input, '12a3456789');
    expect(input).toHaveValue('123456');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('123456');
  });
});
