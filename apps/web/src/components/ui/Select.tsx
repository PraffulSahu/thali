/**
 * Native <select> (best mobile UX + accessibility), styled to match inputs.
 *
 *   <Field label="Reason" required>
 *     <Select value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Choose a reason"
 *       options={[{ value: 'OUT_OF_STOCK', label: 'Item out of stock' }, { value: 'CLOSING', label: 'Kitchen closing' }]} />
 *   </Field>
 */
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { controlClasses, useFieldControl } from './Field';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends ComponentProps<'select'> {
  options?: SelectOption[];
  /** Adds an empty first option (value ""). */
  placeholder?: string;
  invalid?: boolean;
}

export function Select({ options, placeholder, invalid, className, children, ...rest }: SelectProps) {
  const field = useFieldControl(rest);
  return (
    <div className="relative">
      <select
        {...rest}
        {...field}
        aria-invalid={field['aria-invalid'] ?? (invalid || undefined)}
        className={cn(controlClasses, 'h-11 appearance-none pl-3 pr-10 text-base sm:text-[0.9375rem]', className)}
      >
        {placeholder !== undefined ? (
          <option value="" disabled={rest.required}>
            {placeholder}
          </option>
        ) : null}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <Icon name="chevron-down" size={18} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
    </div>
  );
}
