/**
 * Bare toggle switch (design-spec §3.7) — a <button role="switch">. For a labelled settings row use <Switch>.
 *
 *   <Toggle checked={plus} onChange={setPlus} label="Add Thali Plus" />                  // md 44×26
 *   <Toggle size="lg" checked={online} onChange={goOnline} label="Online" pending={saving} />   // 64×36
 *
 * `pending` keeps the knob where it is and shows a 14px spinner left of the switch (server call in flight).
 */
import { cn } from '../../lib/cn';
import { ButtonSpinner } from './Button';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name (or pass `labelledBy`). */
  label?: string;
  labelledBy?: string;
  size?: 'md' | 'lg';
  disabled?: boolean;
  pending?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, label, labelledBy, size = 'md', disabled, pending, className }: ToggleProps) {
  const lg = size === 'lg';
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {pending ? (
        <span className="text-fg-3" aria-hidden="true">
          <ButtonSpinner size={14} />
        </span>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-busy={pending || undefined}
        disabled={disabled}
        onClick={() => !pending && onChange(!checked)}
        className={cn(
          'relative inline-flex shrink-0 rounded-pill border-0 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45',
          lg ? 'h-9 w-16 p-1' : 'h-[26px] w-11 p-[3px]',
          checked ? 'bg-ok' : 'bg-line-2',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'block rounded-full bg-white transition-transform ease-[cubic-bezier(.2,.8,.2,1)]',
            lg ? 'size-7 shadow-[0_1px_3px_rgba(0,0,0,.3)] duration-[280ms]' : 'size-5 shadow-[0_1px_2px_rgba(0,0,0,.3)] duration-[250ms]',
            checked && (lg ? 'translate-x-7' : 'translate-x-[18px]'),
          )}
        />
      </button>
    </span>
  );
}
