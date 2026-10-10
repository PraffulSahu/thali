/**
 * Checkbox / radio option cards (design-spec §3.8): 52px rows, selected = --pri border on --acc-soft.
 * Real inputs inside labels, so forms and keyboard work natively.
 *
 *   <OptionCard type="radio" name="size" value="full" checked={size === 'full'} onChange={() => setSize('full')}
 *     label="Full" aside="₹249" />
 *   <OptionCard type="checkbox" checked={raita} onChange={(e) => setRaita(e.target.checked)} label="Extra raita" aside="+₹30" />
 *   <OptionCard type="checkbox" disabled label="Boiled egg" aside="+₹20" />   // " · Unavailable" suffix
 */
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CheckGlyph } from './Checkbox';
import { RadioGlyph } from './Radio';

export interface OptionCardProps extends Omit<ComponentProps<'input'>, 'type'> {
  type: 'radio' | 'checkbox';
  label: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
}

export function OptionCard({ type, label, description, aside, disabled, checked, className, id, ...rest }: OptionCardProps) {
  const auto = useId().replace(/:/g, '');
  const inputId = id ?? `opt${auto}`;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'flex min-h-[52px] w-full cursor-pointer items-center gap-3 rounded-control border px-3.5 py-2 text-left text-[14.5px] transition-[border-color,background-color] duration-150',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-acc',
        checked ? 'border-pri bg-acc-soft' : 'border-line bg-card hover:border-line-2',
        disabled && 'cursor-not-allowed opacity-45',
        className,
      )}
    >
      <span className="relative flex">
        <input id={inputId} type={type} checked={checked} disabled={disabled} className="peer absolute inset-0 size-[18px] cursor-[inherit] appearance-none opacity-0" {...rest} />
        {type === 'radio' ? <RadioGlyph /> : <CheckGlyph />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-fg">
          {label}
          {disabled ? ' · Unavailable' : null}
        </span>
        {description ? <span className="text-[13px] text-fg-3">{description}</span> : null}
      </span>
      {aside ? <span className="shrink-0 text-fg-3">{aside}</span> : null}
    </label>
  );
}
