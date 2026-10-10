/**
 * Admin sign-in: email + password, then a TOTP code (LLD §5.3). Accounts without MFA enrol first
 * (setup key + otpauth URI), then sign in again with the next code. There is no registration: admins are
 * created by the bootstrap CLI or by a super-admin.
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { ApiError, errorMessage } from '../../lib/errors';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import MfaSetup, { TotpCodeField } from './MfaSetup';

type Step = { kind: 'credentials' } | { kind: 'mfa'; mfaToken: string; notice?: string } | { kind: 'setup' };

/** Only same-app admin paths are allowed as redirect targets (no open redirect). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/admin') || next.startsWith('/admin/login') || next.startsWith('//')) return '/admin';
  return next;
}

function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'ACCOUNT_LOCKED') {
      const until = (e.details as { lockedUntil?: string } | undefined)?.lockedUntil;
      return until ? `This account is locked after too many failed attempts. Try again after ${formatDateTime(until)}.` : 'This account is locked after too many failed attempts. Try again later.';
    }
    if (e.code === 'INVALID_CREDENTIALS') return e.message || 'Incorrect email, password or code.';
    if (e.retryAfterSec) return `Too many attempts. Try again in ${Math.ceil(e.retryAfterSec / 60)} min.`;
  }
  return errorMessage(e);
}

export default function AdminLogin() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status === 'authenticated' && auth.hasRole('ADMIN') && auth.hasMfa) return <Navigate to={next} replace />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(loginError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    void run(async () => {
      const res = await auth.adminLogin(email.trim(), password);
      if (res.kind === 'mfaRequired') setStep({ kind: 'mfa', mfaToken: res.mfaToken });
      else if (res.kind === 'mfaSetupRequired') setStep({ kind: 'setup' });
      // 'signedIn': the guard above redirects once the token carries `mfa`
      setPassword(res.kind === 'mfaSetupRequired' ? password : '');
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'mfa' || code.length !== 6) return;
    void run(async () => {
      try {
        await auth.adminVerifyMfa(step.mfaToken, code);
      } catch (err) {
        setCode('');
        throw err;
      }
    });
  };

  const enable = async (enableCode: string) => {
    const res = await auth.adminEnableMfa(enableCode);
    if (res.signedIn) return;
    // The server wants a fresh login now that MFA is on; the enrolment code can't be reused.
    const login = await auth.adminLogin(email.trim(), password);
    setPassword('');
    setCode('');
    if (login.kind === 'mfaRequired') {
      setStep({ kind: 'mfa', mfaToken: login.mfaToken, notice: 'Authenticator enabled. Wait for your app to show the next code, then enter it to sign in.' });
    } else {
      setStep({ kind: 'credentials' });
      setError('Authenticator enabled. Sign in again to continue.');
    }
  };

  const restart = () => {
    setStep({ kind: 'credentials' });
    setPassword('');
    setCode('');
    setError(null);
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <PageHeader
        title={step.kind === 'setup' ? 'Set up two-factor sign-in' : step.kind === 'mfa' ? 'Enter your authenticator code' : 'Admin sign in'}
        description={
          step.kind === 'setup'
            ? 'Admin access requires an authenticator app. Set it up once, then every sign-in asks for a code.'
            : step.kind === 'mfa'
              ? `Signing in as ${email || 'your admin account'}.`
              : 'Use your admin email and password. Admin accounts are created by an existing super-admin.'
        }
      />
      <Card>
        {step.kind === 'credentials' ? (
          <form onSubmit={submitCredentials} className="flex flex-col gap-4" noValidate>
            <Field label="Email" required>
              <Input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" required>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error ? <InlineError error={new Error(error)} /> : null}
            <Button type="submit" loading={busy} disabled={!email.trim() || !password} fullWidth>
              Continue
            </Button>
          </form>
        ) : null}

        {step.kind === 'mfa' ? (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            {step.notice ? (
              <p role="status" className="rounded-control bg-success-50 px-3 py-2 text-sm text-success-800">
                {step.notice}
              </p>
            ) : null}
            <TotpCodeField value={code} onChange={setCode} />
            {error ? <InlineError error={new Error(error)} /> : null}
            <Button type="submit" loading={busy} disabled={code.length !== 6} fullWidth>
              Verify and sign in
            </Button>
            <Button type="button" variant="ghost" onClick={restart}>
              Use a different account
            </Button>
          </form>
        ) : null}

        {step.kind === 'setup' ? (
          <div className="flex flex-col gap-4">
            <MfaSetup onEnable={enable} />
            <Button type="button" variant="ghost" onClick={restart}>
              Cancel
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
