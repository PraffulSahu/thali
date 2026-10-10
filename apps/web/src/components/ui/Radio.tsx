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

/** 18px radio glyph: --line2 ring; checked = --fg ring + 8px --fg dot. Pair with a `peer` input. */
export function RadioGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-line-2 transition-colors duration-150',
        'peer-checked:border-fg [&>span]:scale-0 peer-checked:[&>span]:scale-100',
        'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-acc',
        className,
      )}
    >
      <span className="size-2 rounded-full bg-fg transition-transform duration-150" />
    </span>
  );
}

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
      <legend className={cn('mb-1 text-sm font-medium text-fg', hideLegend && 'sr-only')}>
        {legend}
        {required ? <span aria-hidden="true" className="ml-0.5 text-bad">*</span> : null}
      </legend>
      {hint ? <p id={hintId} className="-mt-1 text-[13px] text-fg-3">{hint}</p> : null}
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
                  'min-h-[52px] rounded-control border px-3.5 py-2.5 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-acc',
                variant === 'cards' && (checked ? 'border-pri bg-acc-soft' : 'border-line bg-card hover:border-line-2'),
                o.disabled && 'cursor-not-allowed opacity-45',
              )}
            >
              <span className="relative flex">
                <input
                  id={id}
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={checked}
                  disabled={o.disabled}
                  onChange={() => onChange(o.value)}
                  className="peer absolute inset-0 size-[18px] cursor-[inherit] appearance-none opacity-0"
                />
                <RadioGlyph />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14.5px] text-fg">{o.label}</span>
                {o.description ? <span className="text-[13px] text-fg-3">{o.description}</span> : null}
              </span>
              {o.aside ? <span className="shrink-0 text-sm text-fg-3">{o.aside}</span> : null}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-[13px] font-medium text-bad">
          <Icon name="alert" size={14} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
