/**
 * Phone + OTP sign-in form (PRD C-5). Reusable in a page (/signin) or a dialog (consumer LoginDialog).
 *
 *   <OtpSignInForm onSuccess={(user) => navigate(next)} />
 *
 * - Normalizes the phone like the server (`tryNormalizePhone`, default region IN) before sending.
 * - Shows the server cooldown (`resendAfterSec`, `Retry-After` on 429) as a resend countdown.
 * - Shows attempts remaining / expiry / lockout from the error code + details.
 * - In demo mode tells the user the fixed code (only when the server says `demoOtp`).
 * - Guest cart merge happens inside `signInWithOtp` (AuthProvider).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { tryNormalizePhone } from '@thali/contracts';
import { useCountdown } from '../ui/Countdown';
import { useAuth, type AuthUser } from '../../lib/auth';
import { errorMessage, fieldErrors, isApiError, otpErrorInfo } from '../../lib/errors';
import { formatDuration, formatPhone } from '../../lib/format';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Icon } from '../ui/Icon';

export interface OtpSignInFormProps {
  onSuccess?: (user: AuthUser) => void;
  /** Heading level text; omit to render no heading (e.g. inside a titled Dialog). */
  heading?: string;
}

type Step = 'phone' | 'code';

export function OtpSignInForm({ onSuccess, heading }: OtpSignInFormProps) {
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
      const code = isApiError(e) ? e.code : '';
      let msg = errorMessage(e);
      if (code === 'OTP_INVALID' && info.attemptsRemaining !== undefined) {
        msg = info.attemptsRemaining > 0
          ? `That code isn't right. ${info.attemptsRemaining} ${info.attemptsRemaining === 1 ? 'attempt' : 'attempts'} left.`
          : 'That code isn’t right and no attempts are left. Request a new code.';
      }
      setCodeError(msg);
      setCode('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {heading ? <h1 className="text-2xl font-bold tracking-tight text-slate-900">{heading}</h1> : null}
      {step === 'phone' ? (
        <form onSubmit={onPhoneSubmit} noValidate className="flex flex-col gap-4">
          <Field label="Mobile number" hint="We'll text you a 6-digit code." error={phoneError} required>
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              prefix="+91"
              placeholder="98765 43210"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              maxLength={16}
            />
          </Field>
          <Button type="submit" fullWidth loading={busy}>
            Send code
          </Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <div aria-live="polite" className="flex flex-col gap-2">
            {notice ? <p className="text-[0.9375rem] text-slate-700">{notice}</p> : null}
            {demo ? (
              <p className="flex items-start gap-2 rounded-control bg-info-50 px-3 py-2 text-sm text-info-800">
                <Icon name="info" size={16} className="mt-0.5" />
                Demo mode: no SMS is sent. Use code 123456.
              </p>
            ) : null}
          </div>
          <Field label="6-digit code" error={codeError} required>
            <Input
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="••••••"
              className="text-center font-mono text-xl tracking-[0.5em]"
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }}
            />
          </Field>
          <Button type="submit" fullWidth loading={busy}>
            Verify and continue
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Button
              variant="link"
              onClick={() => {
                setStep('phone');
                setCodeError(null);
                setNotice(null);
              }}
            >
              Change number
            </Button>
            {resendLeft && resendLeft > 0 ? (
              <span className="text-slate-600 tabular-nums">Resend code in {formatDuration(resendLeft)}</span>
            ) : (
              <Button variant="link" onClick={() => void sendCode(phone)} disabled={busy}>
                Resend code
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
