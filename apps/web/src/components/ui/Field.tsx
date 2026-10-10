/**
 * Accessible form field wrapper: renders the <label>, optional hint and error, and wires the child
 * control (Input / Select / Textarea from this folder) via context: `id`, `aria-describedby`,
 * `aria-invalid`, `required`.
 *
 *   <Field label="Phone number" hint="We'll send a 6-digit code" error={errors.phone} required>
 *     <Input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={...} />
 *   </Field>
 *
 * For a custom control use `useFieldControl()` to get the same props.
 */
import { createContext, useContext, useId, type AriaAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Props to spread on a control inside <Field>; `{}` outside a Field. */
export function useFieldControl(props: { id?: string; 'aria-describedby'?: string; required?: boolean; 'aria-invalid'?: AriaAttributes['aria-invalid'] } = {}) {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  const describedBy = [ctx.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return {
    id: props.id ?? ctx.id,
    'aria-describedby': describedBy,
    'aria-invalid': ctx.invalid || props['aria-invalid'] === true || props['aria-invalid'] === 'true' ? (true as const) : undefined,
    required: props.required ?? (ctx.required || undefined),
  };
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  /** Error text; when set the control gets aria-invalid and the message is announced with it. */
  error?: ReactNode;
  required?: boolean;
  /** Show "(optional)" after the label. */
  optional?: boolean;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
  id?: string;
  className?: string;
}

export function Field({ label, children, hint, error, required = false, optional, hideLabel, id, className }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `f${autoId.replace(/:/g, '')}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const ctx: FieldContextValue = {
    id: controlId,
    describedBy: [errorId, hintId].filter(Boolean).join(' ') || undefined,
    invalid: Boolean(error),
    required,
  };
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className={cn('text-sm font-medium text-slate-800', hideLabel && 'sr-only')}>
        {label}
        {required ? <span aria-hidden="true" className="ml-0.5 text-danger-700">*</span> : null}
        {optional && !required ? <span className="ml-1 font-normal text-slate-500">(optional)</span> : null}
      </label>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hint ? (
        <p id={hintId} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger-700">
          <Icon name="alert" size={16} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Shared control styling (inputs, selects, textareas). */
export const controlClasses =
  'w-full rounded-control border border-slate-300 bg-surface text-slate-900 placeholder:text-slate-400 ' +
  'transition-[border-color,box-shadow] duration-150 hover:border-slate-400 ' +
  'focus:outline-none focus-visible:outline-none focus:border-brand-500 focus:ring-3 focus:ring-brand-500/25 ' +
  'aria-invalid:border-danger-600 aria-invalid:focus:ring-danger-600/20 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 read-only:bg-slate-50';
