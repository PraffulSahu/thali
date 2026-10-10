/**
 * Code digit boxes (design-spec §3.15).
 *
 *   <CodeDigits code="4719" label="Delivery code" />                 // display, 44×52 boxes
 *   <CodeDigits code="8250" label="Pickup code" size="lg" />         // owner pickup panel, 46×56
 *
 *   const [code, setCode] = useState('');
 *   <CodeEntry length={4} value={code} onChange={setCode} onComplete={submit}
 *     label="Customer's delivery code" error={wrong ? 'Wrong code · 4 attempts left' : undefined} />
 *     // 52×60 inputs labelled "Digit n": auto-advance, paste-to-fill, backspace-to-previous, arrows
 *
 *   <OtpInput value={otp} onChange={setOtp} onComplete={verify} label="6-digit code" invalid={!!err} />
 *     // sign-in OTP: ONE real input (SMS autofill `one-time-code`, paste, screen readers) drawn as 6 boxes
 */
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface CodeDigitsProps {
  code: string;
  /** Group label, spelled out with the digits for screen readers: "Delivery code 4 7 1 9". */
  label: string;
  size?: 'md' | 'lg';
  className?: string;
}

export function CodeDigits({ code, label, size = 'md', className }: CodeDigitsProps) {
  const digits = code.split('');
  return (
    <div role="group" aria-label={`${label} ${digits.join(' ')}`} className={cn('flex gap-1.5', className)}>
      {digits.map((d, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            'grid place-items-center rounded-control border border-line bg-bg-2 font-mono font-medium text-fg',
            size === 'lg' ? 'h-14 w-[46px] text-[28px]' : 'h-[52px] w-11 text-[26px]',
          )}
        >
          {d}
        </span>
      ))}
    </div>
  );
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');

export interface CodeEntryProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  /** Called once all boxes are filled. */
  onComplete?: (value: string) => void;
  /** Visible legend above the boxes. */
  label: ReactNode;
  hideLabel?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export function CodeEntry({ length = 4, value, onChange, onComplete, label, hideLabel, error, hint, disabled, autoFocus, className }: CodeEntryProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const id = useId().replace(/:/g, '');
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const commit = (next: string) => {
    const v = onlyDigits(next).slice(0, length);
    onChange(v);
    if (v.length === length) onComplete?.(v);
    return v;
  };

  const setAt = (i: number, d: string) => {
    const arr = digits.slice();
    arr[i] = d;
    // keep the value contiguous: entering at i fills from the first empty slot
    const joined = arr.join('');
    return commit(joined);
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) {
        setAt(i, '');
      } else if (i > 0) {
        setAt(i - 1, '');
        focus(i - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(i + 1);
    } else if (/^\d$/.test(e.key)) {
      e.preventDefault();
      const at = Math.min(i, value.length); // never leave holes
      setAt(at, e.key);
      focus(at + 1);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); // block letters
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const v = commit(e.clipboardData.getData('text'));
    focus(v.length);
  };

  return (
    <fieldset className={cn('flex flex-col gap-2', className)} aria-describedby={error ? `ce${id}-err` : hint ? `ce${id}-hint` : undefined}>
      <legend className={cn('mb-2 text-sm font-medium text-fg', hideLabel && 'sr-only')}>{label}</legend>
      <div className="flex gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={d}
            onChange={(e) => {
              // mobile keyboards / autofill that bypass keydown
              const v = onlyDigits(e.target.value);
              if (v.length > 1) {
                const done = commit(value.slice(0, i) + v);
                focus(done.length);
              } else if (v.length === 1) {
                setAt(Math.min(i, value.length), v);
                focus(i + 1);
              }
            }}
            onKeyDown={onKeyDown(i)}
            onPaste={onPaste}
            onFocus={(e) => e.currentTarget.select()}
            inputMode="numeric"
            autoComplete="off"
            maxLength={1}
            aria-label={`Digit ${i + 1}`}
            aria-invalid={error ? true : undefined}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            className={cn(
              'h-[60px] w-[52px] rounded-control border bg-bg text-center font-mono text-[26px] font-medium text-fg outline-none transition-[border-color,box-shadow] duration-150',
              'focus:border-fg-3 focus:shadow-[0_0_0_4px_var(--muted)] disabled:opacity-45',
              error ? 'border-bad focus:shadow-[0_0_0_4px_var(--bad-bg)]' : 'border-line',
            )}
          />
        ))}
      </div>
      {error ? (
        <p id={`ce${id}-err`} role="alert" className="flex items-center gap-1.5 text-[13px] text-bad">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : hint ? (
        <p id={`ce${id}-hint`} className="text-[12.5px] text-fg-3">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

export interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  /** Accessible name of the single input (keep "6-digit code" for the sign-in flows). */
  label: string;
  length?: number;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}

/** One-input OTP drawn as N boxes (sign-in, design-spec §3.15 "OTP"). */
export function OtpInput({ value, onChange, onComplete, label, length = 6, invalid, disabled, describedBy, id, inputRef, className }: OtpInputProps) {
  const active = Math.min(value.length, length - 1);
  const [focused, setFocused] = useState(false);
  return (
    <div className={cn('relative', className)}>
      <div aria-hidden="true" className="grid gap-2 max-sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}>
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn(
              'grid h-14 place-items-center rounded-control border bg-bg font-mono text-[22px] font-medium text-fg transition-[border-color,box-shadow] duration-150 max-sm:h-[52px]',
              invalid ? 'border-bad' : 'border-line',
              focused && i === active && (invalid ? 'shadow-[0_0_0_4px_var(--bad-bg)]' : 'border-fg-3 shadow-[0_0_0_4px_var(--muted)]'),
            )}
          >
            {value[i] ?? ''}
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d*"
        maxLength={length}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const v = onlyDigits(e.target.value).slice(0, length);
          const was = value.length;
          onChange(v);
          if (v.length === length && was !== length) onComplete?.(v);
        }}
        className={cn(
          'absolute inset-0 h-full w-full cursor-text rounded-control bg-transparent text-transparent caret-transparent outline-none focus-visible:outline-none',
          'selection:bg-transparent disabled:cursor-not-allowed',
        )}
        style={{ letterSpacing: '2em', fontSize: 16 }}
      />
    </div>
  );
}
