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
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={controlId} className={cn('text-sm font-medium text-fg', hideLabel && 'sr-only')}>
        {label}
        {required ? <span aria-hidden="true" className="ml-0.5 text-bad">*</span> : null}
        {optional && !required ? <span className="ml-1 font-normal text-fg-3">(optional)</span> : null}
      </label>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hint ? (
        <p id={hintId} className="text-[13px] text-fg-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-[13px] font-medium text-bad">
          <Icon name="alert" size={14} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shared control styling (inputs, selects, textareas), app tier (design-spec §3.2): 1px --line, 12px radius,
 * --bg fill; focus = --fg3 border + 4px --muted ring; invalid = --bad border + 4px --bad-bg ring.
 */
export const controlClasses =
  'w-full rounded-control border border-line bg-bg text-fg placeholder:text-fg-3 ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'focus:outline-none focus-visible:outline-none focus:border-fg-3 focus:shadow-[0_0_0_4px_var(--muted)] ' +
  'aria-invalid:border-bad aria-invalid:focus:shadow-[0_0_0_4px_var(--bad-bg)] ' +
  'disabled:cursor-not-allowed disabled:opacity-45 read-only:bg-bg-2';

/** Marketing tier (board 00/02): 48px, 1.5px --line2, 14px radius, --card fill, 500 weight. */
export const marketingControlClasses =
  'w-full rounded-field border-[1.5px] border-line-2 bg-card text-fg font-medium placeholder:text-fg-3 ' +
  'transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-pri focus:shadow-[0_0_0_4px_var(--acc-soft)]';
