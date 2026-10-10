/**
 * Admin sign-in (board 01, Admin tab): work email + password → authenticator code (TOTP). Accounts without MFA
 * enrol inline (setup key + otpauth URI, then confirm a code). Uses the AuthProvider admin methods
 * (`adminLogin`, `adminVerifyMfa`, `adminSetupMfa`, `adminEnableMfa`).
 *
 *   <AdminSignInForm onSignedIn={() => navigate(destinationAfterSignIn('admin', roles, next))} />
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../lib/auth';
import { ApiError, errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { Button, IconButton } from '../ui/Button';
import { OtpInput } from '../ui/CodeDigits';
import { ErrorState, InlineError } from '../ui/ErrorState';
import { Field } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

type Step = { kind: 'credentials' } | { kind: 'mfa'; mfaToken: string; notice?: string } | { kind: 'setup' };

export function adminLoginError(e: unknown): string {
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

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function CodeStep({ label, busy, error, onSubmit, submitLabel }: { label: string; busy: boolean; error: string | null; onSubmit: (code: string) => void; submitLabel: string }) {
  const [code, setCode] = useState('');
  useEffect(() => {
    if (error) setCode('');
  }, [error]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) onSubmit(code);
      }}
      className="flex flex-col gap-4"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">{label}</legend>
        <OtpInput
          label="Authenticator code"
          value={code}
          invalid={Boolean(error)}
          onChange={setCode}
          onComplete={(v) => {
            if (!busy) onSubmit(v);
          }}
        />
      </fieldset>
      {error ? <InlineError error={new Error(error)} /> : null}
      <Button type="submit" size="lg" fullWidth loading={busy} disabled={code.length !== 6} className="h-[46px]">
        {submitLabel}
      </Button>
    </form>
  );
}

function MfaEnrol({ onEnable }: { onEnable: (code: string) => Promise<void> }) {
  const auth = useAuth();
  const { toast } = useToast();
  // Setup replaces the server-side secret: run once per mount (query de-dupes StrictMode double effects).
  const setup = useQuery({
    queryKey: ['admin', 'mfa-setup', 'signin'],
    queryFn: () => auth.adminSetupMfa(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (setup.isPending) return <p role="status" className="text-sm text-fg-3">Preparing your authenticator setup…</p>;
  if (setup.isError) return <ErrorState compact error={setup.error} title="Couldn't start authenticator setup" onRetry={() => setup.refetch()} />;
  const { otpauthUri, secret } = setup.data;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied`, tone: 'success' });
    } catch {
      toast({ title: `Couldn't copy ${what.toLowerCase()}`, description: 'Select the text and copy it manually.', tone: 'warn' });
    }
  };
  const submit = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      await onEnable(code);
    } catch (e) {
      setError(adminLoginError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3 rounded-control border border-line bg-bg-2 p-4 text-sm text-fg-2">
        <li>
          <span className="font-semibold text-fg">1.</span> In your authenticator app add an account with a <strong>setup key</strong> (time-based, 6 digits).
        </li>
        {secret ? (
          <li className="flex flex-wrap items-center gap-2">
            <code className="select-all break-all rounded-xs bg-card px-2 py-1 font-mono text-[15px] font-medium tracking-wider text-fg">{groupSecret(secret)}</code>
            <IconButton icon="copy" label="Copy setup key" size="sm" variant="outline" onClick={() => void copy(secret, 'Setup key')} />
          </li>
        ) : null}
        <li className="flex flex-col gap-1.5">
          <span>
            <span className="font-semibold text-fg">2.</span> Or open this link on your phone:
          </span>
          <span className="flex items-start gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-fg-2">{otpauthUri}</code>
            <IconButton icon="copy" label="Copy setup link" size="sm" variant="outline" onClick={() => void copy(otpauthUri, 'Setup link')} />
          </span>
        </li>
      </ol>
      <CodeStep label="Code from your authenticator app" busy={busy} error={error} onSubmit={(c) => void submit(c)} submitLabel="Enable MFA" />
    </div>
  );
}

export interface AdminSignInFormProps {
  onSignedIn?: () => void;
  onStepChange?: (step: Step['kind']) => void;
}

export function AdminSignInForm({ onSignedIn, onStepChange }: AdminSignInFormProps) {
  const auth = useAuth();
  const [step, setStepState] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setStep = (s: Step) => {
    setStepState(s);
    onStepChange?.(s.kind);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(adminLoginError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your work email and password.');
      return;
    }
    void run(async () => {
      const res = await auth.adminLogin(email.trim(), password);
      if (res.kind === 'mfaRequired') {
        setStep({ kind: 'mfa', mfaToken: res.mfaToken });
        setPassword('');
      } else if (res.kind === 'mfaSetupRequired') setStep({ kind: 'setup' });
      else onSignedIn?.();
    });
  };

  const verify = (code: string) => {
    if (step.kind !== 'mfa') return;
    void run(async () => {
      await auth.adminVerifyMfa(step.mfaToken, code);
      onSignedIn?.();
    });
  };

  const enable = async (code: string) => {
    const res = await auth.adminEnableMfa(code);
    if (res.signedIn) {
      onSignedIn?.();
      return;
    }
    // The server wants a fresh login now that MFA is on; the enrolment code can't be reused.
    const login = await auth.adminLogin(email.trim(), password);
    setPassword('');
    if (login.kind === 'mfaRequired') {
      setStep({ kind: 'mfa', mfaToken: login.mfaToken, notice: 'Authenticator enabled. Wait for the next code in your app, then enter it.' });
    } else {
      setStep({ kind: 'credentials' });
      setError('Authenticator enabled. Sign in again to continue.');
    }
  };

  const restart = () => {
    setStep({ kind: 'credentials' });
    setPassword('');
    setError(null);
  };

  if (step.kind === 'credentials') {
    return (
      <form key="cred" onSubmit={submitCredentials} noValidate className="flex animate-swap flex-col gap-4">
        <Field label="Work email" required>
          <Input type="email" autoComplete="username" inputMode="email" placeholder="you@thali.app" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="admin-password" className="text-sm font-medium text-fg">
              Password<span aria-hidden="true" className="ml-0.5 text-bad">*</span>
            </label>
            <Link to={email.trim() ? `/admin/forgot?email=${encodeURIComponent(email.trim())}` : '/admin/forgot'} className="text-[13px] font-semibold text-fg-3 hover:text-acc-fg">
              Forgot?
            </Link>
          </div>
          <div className="relative">
            <Input
              id="admin-password"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-12"
            />
            <span className="absolute right-0.5 top-[3px]">
              <IconButton
                icon={show ? 'eye-off' : 'eye'}
                label={show ? 'Hide password' : 'Show password'}
                size="md"
                onClick={() => setShow((v) => !v)}
                aria-pressed={show}
              />
            </span>
          </div>
        </div>
        {error ? <InlineError error={new Error(error)} /> : null}
        <Button type="submit" size="lg" fullWidth loading={busy} className="h-[46px]">
          Continue
        </Button>
      </form>
    );
  }

  if (step.kind === 'mfa') {
    return (
      <div key="mfa" className="flex animate-swap flex-col gap-4">
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-2">
          <span>Signed in as {email}</span>
          <button type="button" onClick={restart} className="font-semibold text-fg underline underline-offset-2 hover:text-acc-fg">
            Change
          </button>
        </p>
        {step.notice ? (
          <p role="status" className="flex items-start gap-2 rounded-control bg-ok-bg px-3 py-2 text-sm text-ok">
            <Icon name="check" size={16} className="mt-0.5" />
            {step.notice}
          </p>
        ) : null}
        <CodeStep label="Code from your authenticator app" busy={busy} error={error} onSubmit={verify} submitLabel="Verify & continue" />
      </div>
    );
  }

  return (
    <div key="setup" className="flex animate-swap flex-col gap-4">
      <p className="text-sm text-fg-2">Admin access needs an authenticator app. Set it up once; every sign-in then asks for a fresh code.</p>
      <MfaEnrol onEnable={enable} />
      <Button variant="ghost" onClick={restart}>
        Cancel
      </Button>
    </div>
  );
}
