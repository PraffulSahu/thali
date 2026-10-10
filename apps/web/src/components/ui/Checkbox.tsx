/**
 * Checkbox and switch with an inline label; the whole row is a 44px target.
 *
 *   <Checkbox label="Veg only" checked={veg} onChange={(e) => setVeg(e.target.checked)} />
 *   <Checkbox label="Use membership" description="Free delivery on orders above ₹199" ... />
 *   <Switch label="Online" checked={online} onChange={...} />
 */
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, disabled, ...rest }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? `cb${auto.replace(/:/g, '')}`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <label
      htmlFor={inputId}
      className={cn('flex min-h-touch cursor-pointer items-start gap-3 py-2.5', disabled && 'cursor-not-allowed opacity-60', className)}
    >
      <input
        id={inputId}
        type="checkbox"
        disabled={disabled}
        aria-describedby={descId}
        className="mt-0.5 size-5 shrink-0 cursor-[inherit] rounded border-slate-400 accent-brand-600"
        {...rest}
      />
      <span className="flex flex-col">
        <span className="text-[0.9375rem] font-medium text-slate-900">{label}</span>
        {description ? (
          <span id={descId} className="text-sm text-slate-600">
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

/** On/off toggle (a checkbox with role="switch"). */
export function Switch({ label, description, className, id, disabled, checked, ...rest }: SwitchProps) {
  const auto = useId();
  const inputId = id ?? `sw${auto.replace(/:/g, '')}`;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <label
      htmlFor={inputId}
      className={cn('flex min-h-touch cursor-pointer items-center justify-between gap-4 py-2', disabled && 'cursor-not-allowed opacity-60', className)}
    >
      <span className="flex flex-col">
        <span className="text-[0.9375rem] font-medium text-slate-900">{label}</span>
        {description ? (
          <span id={descId} className="text-sm text-slate-600">
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
            'h-7 w-12 rounded-pill bg-slate-300 transition-colors duration-150 peer-checked:bg-success-700',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500',
            "after:absolute after:left-0.5 after:top-0.5 after:size-6 after:rounded-full after:bg-white after:shadow-raised after:transition-transform after:duration-150 after:content-['']",
            'peer-checked:after:translate-x-5',
          )}
        />
      </span>
    </label>
  );
}
