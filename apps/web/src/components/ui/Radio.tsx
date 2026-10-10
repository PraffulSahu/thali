/**
 * Radio group rendered as a <fieldset> with a <legend>. Supports per-option descriptions (e.g. prep times,
 * add-on prices) and an error message.
 *
 *   <RadioGroup legend="Prep time" name="prep" value={prep} onChange={setPrep}
 *     options={[{ value: '15', label: '15 min' }, { value: '25', label: '25 min' }]} />
 *   <RadioGroup legend="Size" variant="cards" ... />   // bordered selectable rows
 */
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  /** Right-aligned extra, e.g. <Price paise={2000} /> */
  aside?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: ReactNode;
  name: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: RadioOption[];
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  variant?: 'plain' | 'cards';
  hideLegend?: boolean;
  className?: string;
}

export function RadioGroup({
  legend, name, value, onChange, options, hint, error, required, variant = 'plain', hideLegend, className,
}: RadioGroupProps) {
  const auto = useId().replace(/:/g, '');
  const hintId = hint ? `rg${auto}-hint` : undefined;
  const errorId = error ? `rg${auto}-error` : undefined;
  return (
    <fieldset
      className={cn('flex flex-col gap-1.5', className)}
      aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
      aria-required={required || undefined}
    >
      <legend className={cn('mb-1 text-sm font-medium text-slate-800', hideLegend && 'sr-only')}>
        {legend}
        {required ? <span aria-hidden="true" className="ml-0.5 text-danger-700">*</span> : null}
      </legend>
      {hint ? <p id={hintId} className="-mt-1 text-sm text-slate-600">{hint}</p> : null}
      <div className={cn('flex flex-col', variant === 'cards' && 'gap-2')}>
        {options.map((o) => {
          const id = `rg${auto}-${o.value}`;
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                'flex min-h-touch cursor-pointer items-center gap-3',
                variant === 'plain' && 'py-2',
                variant === 'cards' &&
                  'rounded-control border px-3 py-2.5 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500',
                variant === 'cards' && (checked ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-surface hover:border-slate-400'),
                o.disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                className={cn('size-5 shrink-0 accent-brand-600', variant === 'cards' && 'focus-visible:outline-none')}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[0.9375rem] font-medium text-slate-900">{o.label}</span>
                {o.description ? <span className="text-sm text-slate-600">{o.description}</span> : null}
              </span>
              {o.aside ? <span className="shrink-0 text-sm text-slate-700">{o.aside}</span> : null}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger-700">
          <Icon name="alert" size={16} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
