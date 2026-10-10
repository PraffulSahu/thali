import '../setup';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  __resetThemeForTests,
  readStoredPreference,
  resolveTheme,
  useTheme,
} from '../../src/lib/theme';
import { ThemeToggle, ThemeSegmented } from '../../src/components/ui/ThemeToggle';

type Listener = (e: { matches: boolean }) => void;
function mockSystemDark(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query.includes('dark') ? matches : false;
      },
      media: query,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    })),
  );
  return {
    set(next: boolean) {
      matches = next;
      for (const l of listeners) l({ matches: next });
    },
  };
}

function Probe() {
  const t = useTheme();
  return (
    <div>
      <span data-testid="pref">{t.preference}</span>
      <span data-testid="resolved">{t.resolved}</span>
      <button type="button" onClick={() => t.setPreference('system')}>system</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  __resetThemeForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('theme', () => {
  it('reads and validates the stored preference', () => {
    expect(readStoredPreference()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredPreference()).toBe('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(readStoredPreference()).toBe('system');
  });

  it('resolves system against prefers-color-scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('applies the stored theme to <html data-theme> and follows the system when on "system"', () => {
    const system = mockSystemDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('pref')).toHaveTextContent('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => system.set(false));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });

  it('toggle persists an explicit choice in localStorage and flips data-theme', async () => {
    mockSystemDark(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'system' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('segmented control is a radiogroup (Light / Dark / System) with the preference checked', async () => {
    const system = mockSystemDark(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeSegmented />
      </ThemeProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    // back to following the OS
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => system.set(true));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('works without a provider (store is module-level)', async () => {
    mockSystemDark(false);
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
