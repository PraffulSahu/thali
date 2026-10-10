/**
 * Checkbox and switch with an inline label; the whole row is a 44px target (design-spec §3.7, §3.8).
 *
 *   <Checkbox label="Veg only" checked={veg} onChange={(e) => setVeg(e.target.checked)} />
 *   <Checkbox label="Use membership" description="Free delivery on orders above ₹199" ... />
 *   <Switch label="Order updates" checked={on} onChange={...} />     // labelled row with the md track
 *
 * For a bare switch (partner online 64px, checkout Thali Plus 44px) use <Toggle> (ui/Toggle).
 */
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

/** 18px checkbox glyph: --line2 ring, checked = --fg fill + --pri-fg check. Pair with a `peer` input. */
export function CheckGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] border-line-2 text-transparent transition-colors duration-150',
        'peer-checked:border-fg peer-checked:bg-fg peer-checked:text-pri-fg',
        'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-acc',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 12 5 5 9-10" />
      </svg>
    </span>
  );
}

export function Checkbox({ label, description, className, id, disabled, ...rest }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? `cb${auto.replace(/:/g, '')}`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <label
      htmlFor={inputId}
      className={cn('flex min-h-touch cursor-pointer items-start gap-3 py-2.5', disabled && 'cursor-not-allowed opacity-45', className)}
    >
      <span className="relative mt-px flex">
        <input
          id={inputId}
          type="checkbox"
          disabled={disabled}
          aria-describedby={descId}
          className="peer absolute inset-0 size-[18px] cursor-[inherit] appearance-none opacity-0"
          {...rest}
        />
        <CheckGlyph />
      </span>
      <span className="flex flex-col">
        <span className="text-[14.5px] text-fg">{label}</span>
        {description ? (
          <span id={descId} className="text-[13px] text-fg-3">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export interface SwitchProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

/** On/off row (a checkbox with role="switch"): label left, 44×26 track right (on = --ok). */
export function Switch({ label, description, className, id, disabled, checked, ...rest }: SwitchProps) {
  const auto = useId();
  const inputId = id ?? `sw${auto.replace(/:/g, '')}`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <label
      htmlFor={inputId}
      className={cn('flex min-h-touch cursor-pointer items-center justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-45', className)}
    >
      <span className="flex flex-col">
        <span className="text-[14.5px] font-medium text-fg">{label}</span>
        {description ? (
          <span id={descId} className="text-[13px] text-fg-3">
            {description}
          </span>
        ) : null}
      </span>
      <span className="relative inline-flex shrink-0">
        <input
          id={inputId}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={descId}
          className="peer absolute inset-0 z-10 cursor-[inherit] opacity-0"
          {...rest}
        />
        <span
          aria-hidden="true"
          className={cn(
            'relative h-[26px] w-11 rounded-pill bg-line-2 transition-colors duration-200 peer-checked:bg-ok',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-acc',
            "after:absolute after:left-[3px] after:top-[3px] after:size-5 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(0,0,0,.3)] after:transition-transform after:duration-250 after:ease-[cubic-bezier(.2,.8,.2,1)] after:content-['']",
            'peer-checked:after:translate-x-[18px]',
          )}
        />
      </span>
    </label>
  );
}
