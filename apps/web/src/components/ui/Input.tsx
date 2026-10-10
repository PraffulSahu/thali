/**
 * Text inputs. Use inside <Field> for label/hint/error wiring.
 *
 *   <Field label="Search"><Input type="search" icon="search" placeholder="Biryani, dosa…" /></Field>
 *   <Field label="Price (₹)"><Input inputMode="decimal" suffix="per plate" /></Field>
 *   <Field label="Notes"><Textarea rows={3} maxLength={200} /></Field>
 */
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { controlClasses, useFieldControl } from './Field';
import { Icon, type IconName } from './Icon';

export interface InputProps extends Omit<ComponentProps<'input'>, 'prefix'> {
  /** Leading icon inside the input. */
  icon?: IconName;
  /** Text/node at the start, e.g. "+91". */
  prefix?: ReactNode;
  /** Text/node at the end, e.g. "min". */
  suffix?: ReactNode;
  /** Mark invalid without a Field. */
  invalid?: boolean;
}

export function Input({ icon, prefix, suffix, invalid, className, ...rest }: InputProps) {
  const field = useFieldControl(rest);
  const input = (
    <input
      {...rest}
      {...field}
      aria-invalid={field['aria-invalid'] ?? (invalid || undefined)}
      className={cn(
        controlClasses,
        'h-11 px-3 text-base sm:text-[0.9375rem]',
        (icon || prefix) && 'pl-10',
        prefix && typeof prefix === 'string' && prefix.length > 2 && 'pl-14',
        suffix && 'pr-14',
        className,
      )}
    />
  );
  if (!icon && !prefix && !suffix) return input;
  return (
    <div className="relative">
      {icon || prefix ? (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-500">
          {icon ? <Icon name={icon} size={18} /> : <span className="text-[0.9375rem]">{prefix}</span>}
        </span>
      ) : null}
      {input}
      {suffix ? (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-500">{suffix}</span>
      ) : null}
    </div>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, rows = 3, ...rest }: TextareaProps) {
  const field = useFieldControl(rest);
  return (
    <textarea
      rows={rows}
      {...rest}
      {...field}
      aria-invalid={field['aria-invalid'] ?? (invalid || undefined)}
      className={cn(controlClasses, 'min-h-touch px-3 py-2.5 text-base sm:text-[0.9375rem] leading-relaxed', className)}
    />
  );
}
