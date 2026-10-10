/**
 * +91 phone input (design-spec §3.3): static "+91" prefix box + tel field. Use inside <Field> for label,
 * hint and error wiring. Accepts "98765 43210", "+91…", "0…"; formats as "98765 43210" on blur.
 *
 *   <Field label="Mobile number" hint="We'll text a 6-digit code. Standard SMS rates may apply." error={err}>
 *     <PhoneInput value={phone} onChange={setPhone} />
 *   </Field>
 *   const e164 = toE164India(phone);   // "+919876543210" | null  (contracts' tryNormalizePhone also works)
 */
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { controlClasses, useFieldControl } from './Field';

/** National 10-digit mobile from loose input ("+91 98765-43210", "098765 43210") or null. */
export function nationalMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export function toE164India(raw: string): string | null {
  const n = nationalMobile(raw);
  return n ? `+91${n}` : null;
}

/** "9876543210" → "98765 43210" (anything else returned unchanged). */
export function formatMobileGroups(raw: string): string {
  const n = nationalMobile(raw);
  return n ? `${n.slice(0, 5)} ${n.slice(5)}` : raw;
}

export interface PhoneInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'prefix'> {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}

export function PhoneInput({ value, onChange, invalid, className, onBlur, ...rest }: PhoneInputProps) {
  const field = useFieldControl(rest);
  return (
    <div className="flex gap-2">
      <span
        aria-hidden="true"
        className="inline-flex h-[46px] shrink-0 items-center rounded-control border border-line bg-bg-2 px-3.5 font-mono text-[15px] text-fg-2"
      >
        +91
      </span>
      <input
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="98765 43210"
        maxLength={16}
        {...rest}
        {...field}
        aria-invalid={field['aria-invalid'] ?? (invalid || undefined)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          onChange(formatMobileGroups(e.target.value));
          onBlur?.(e);
        }}
        className={cn(controlClasses, 'h-[46px] min-w-0 flex-1 px-3.5 text-base sm:text-[15px]', className)}
      />
    </div>
  );
}
