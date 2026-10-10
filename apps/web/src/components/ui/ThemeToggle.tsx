/**
 * Theme controls (design-spec §3.35, §3.4 theme segmented). Both read/write the shared theme store (lib/theme).
 *
 *   <ThemeToggle />                      // ghost icon button: moon in light, sun in dark ("Switch to dark mode")
 *   <ThemeToggle variant="outline" />    // sign-in header
 *   <ThemeSegmented />                   // "☀ Light | ☾ Dark | ▭ System" radiogroup (public utility bar)
 *   <ThemeSegmented iconOnly />          // ≤640px
 */
import type { KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';
import { useTheme, type ThemePreference } from '../../lib/theme';
import { IconButton, type ButtonSize } from './Button';
import { Icon } from './Icon';

export interface ThemeToggleProps {
  variant?: 'ghost' | 'outline';
  size?: ButtonSize;
  className?: string;
}

export function ThemeToggle({ variant = 'ghost', size = 'md', className }: ThemeToggleProps) {
  const { resolved, toggle } = useTheme();
  const dark = resolved === 'dark';
  return (
    <IconButton
      icon={dark ? 'sun' : 'moon'}
      label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      variant={variant}
      size={size}
      onClick={toggle}
      className={className}
    />
  );
}

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: 'sun' | 'moon' | 'monitor' }> = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

export function ThemeSegmented({ iconOnly, className }: { iconOnly?: boolean; className?: string }) {
  const { preference, setPreference } = useTheme();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = OPTIONS.findIndex((o) => o.value === preference);
    const next = OPTIONS[(i + dir + OPTIONS.length) % OPTIONS.length]!.value;
    setPreference(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown} className={cn('inline-flex gap-0.5 rounded-badge bg-fill p-0.5', className)}>
      {OPTIONS.map((o) => {
        const checked = preference === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? o.label : undefined}
            data-value={o.value}
            tabIndex={checked ? 0 : -1}
            onClick={() => setPreference(o.value)}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-xs px-[9px] text-xs font-bold transition-colors duration-150 [@media(pointer:coarse)]:h-9',
              checked ? 'bg-card text-fg shadow-[0_1px_2px_rgba(0,0,0,.12)]' : 'text-fg-3 hover:text-fg',
            )}
          >
            <Icon name={o.icon} size={13} strokeWidth={2} />
            {iconOnly ? null : o.label}
          </button>
        );
      })}
    </div>
  );
}
