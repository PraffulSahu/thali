/**
 * Phone + OTP sign-in form (PRD C-5; board 01 styling). Reusable in a page (/signin) or a dialog (consumer
 * LoginDialog).
 *
 *   <OtpSignInForm onSuccess={(user) => navigate(next)} />
 *   <OtpSignInForm submitLabel="Send code" onSuccess={…} />
 *
 * - Normalizes the phone like the server (`tryNormalizePhone`, default region IN) before sending.
 * - Shows the server cooldown (`resendAfterSec`, `Retry-After` on 429) as a resend countdown.
 * - Wrong code: generic "Incorrect code"; expired / too many attempts: asks for a new code and enables Resend.
 * - In demo mode tells the user the fixed code (only when the server says `demoOtp`).
 * - Guest cart merge happens inside `signInWithOtp` (AuthProvider).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { tryNormalizePhone } from '@thali/contracts';
import { useCountdown } from '../ui/Countdown';
import { useAuth, type AuthUser } from '../../lib/auth';
import { errorMessage, fieldErrors, otpErrorInfo } from '../../lib/errors';
import { formatDuration, formatPhone } from '../../lib/format';
import { Button } from '../ui/Button';
import { OtpInput } from '../ui/CodeDigits';
import { Field } from '../ui/Field';
import { PhoneInput } from '../ui/PhoneInput';
import { Icon } from '../ui/Icon';

export interface OtpSignInFormProps {
  onSuccess?: (user: AuthUser) => void;
  /** Heading level text; omit to render no heading (e.g. inside a titled Dialog). */
  heading?: string;
  /** Called when the step changes (the sign-in page animates the swap). */
  onStepChange?: (step: 'phone' | 'code') => void;
}

type Step = 'phone' | 'code';

export function OtpSignInForm({ onSuccess, heading, onStepChange }: OtpSignInFormProps) {
  const auth = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resendLeft = useCountdown(resendAt);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
    onStepChange?.(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on step change only
  }, [step]);

  const sendCode = async (target: string) => {
    setBusy(true);
    setPhoneError(null);
    setCodeError(null);
    setNotice(null);
    try {
      const res = await auth.requestOtp(target);
      setPhone(target);
      setDemo(res.demo);
      setResendAt(Date.now() + res.resendAfterSec * 1000);
      setCode('');
      setStep('code');
      setNotice(`We sent a 6-digit code to ${formatPhone(target)}.`);
    } catch (e) {
      const info = otpErrorInfo(e);
      if (info.retryAfterSec) setResendAt(Date.now() + info.retryAfterSec * 1000);
      const msg = fieldErrors(e).phone ?? (info.retryAfterSec ? `Please wait ${formatDuration(info.retryAfterSec)} before requesting another code.` : errorMessage(e));
      if (step === 'code') setCodeError(msg);
      else setPhoneError(msg);
    } finally {
      setBusy(false);
    }
  };

  const onPhoneSubmit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = tryNormalizePhone(phoneInput.trim(), 'IN');
    if (!normalized) {
      setPhoneError('Enter a valid 10-digit mobile number.');
      return;
    }
    void sendCode(normalized);
  };

  const verify = async (value: string) => {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setCodeError('Enter the 6-digit code from the SMS.');
      return;
    }
    setBusy(true);
    setCodeError(null);
    try {
      const user = await auth.signInWithOtp(phone, value);
      onSuccess?.(user);
    } catch (e) {
      const info = otpErrorInfo(e);
      // Expired / too many attempts: this code is dead, so offer "Resend code" right away.
      if (info.needsNewCode) setResendAt(null);
      const msg = errorMessage(e);
      setCodeError(msg);
      setCode('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {heading ? <h1 className="text-[32px] leading-[1.1] text-fg">{heading}</h1> : null}
      {step === 'phone' ? (
        <form key="phone" onSubmit={onPhoneSubmit} noValidate className="flex animate-swap flex-col gap-4">
          <Field label="Mobile number" hint="We'll text a 6-digit code. Standard SMS rates may apply." error={phoneError} required>
            <PhoneInput value={phoneInput} onChange={setPhoneInput} />
          </Field>
          <Button type="submit" size="lg" fullWidth loading={busy} className="h-[46px]">
            Send code
          </Button>
        </form>
      ) : (
        <form
          key="code"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
          noValidate
          className="flex animate-swap flex-col gap-4"
        >
          <div aria-live="polite" className="flex flex-col gap-2.5">
            {notice ? (
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
                <span>{notice}</span>
                <button
                  type="button"
                  className="font-semibold text-fg underline underline-offset-2 hover:text-acc-fg"
                  onClick={() => {
                    setStep('phone');
                    setCodeError(null);
                    setNotice(null);
                  }}
                >
                  Change
                </button>
              </p>
            ) : null}
            {demo ? (
              <p className="w-fit rounded-xs bg-warn-bg px-2 py-1 font-mono text-[11.5px] text-warn">Demo mode: no SMS is sent. Use code 123456.</p>
            ) : null}
          </div>
          <fieldset className="flex flex-col gap-2" aria-describedby={codeError ? 'otp-error' : undefined}>
            <legend className="mb-2 text-sm font-medium text-fg">Enter the 6-digit code</legend>
            <OtpInput
              inputRef={codeRef}
              label="6-digit code"
              value={code}
              invalid={Boolean(codeError)}
              describedBy={codeError ? 'otp-error' : undefined}
              onChange={(v) => {
                setCode(v);
                if (codeError) setCodeError(null);
              }}
              onComplete={(v) => void verify(v)}
            />
            {codeError ? (
              <p id="otp-error" role="alert" className="flex items-start gap-1.5 text-[13px] font-medium text-bad">
                <Icon name="alert" size={14} className="mt-0.5" />
                <span>{codeError}</span>
              </p>
            ) : null}
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            {resendLeft && resendLeft > 0 ? (
              <span className="text-fg-3 tabular-nums">Resend code in {formatDuration(resendLeft)}</span>
            ) : (
              <Button variant="link" onClick={() => void sendCode(phone)} disabled={busy}>
                Resend code
              </Button>
            )}
          </div>
          <Button type="submit" size="lg" fullWidth loading={busy} className="h-[46px]">
            Verify &amp; continue
          </Button>
        </form>
      )}
    </div>
  );
}
