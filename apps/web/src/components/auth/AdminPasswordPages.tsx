/**
 * Admin password reset (IDN-1):
 *   /admin/forgot                 POST /auth/admin/password/forgot {email} → always 202 (no account probing)
 *   /admin/reset-password?token=  POST /auth/admin/password/reset {token, newPassword, totpCode} → 204
 *
 * The reset token is read into memory and immediately removed from the URL (history replace), and the page
 * sets `<meta name="referrer" content="no-referrer">` while mounted so the token never leaks via Referer.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { ApiError, errorMessage, fieldErrors } from '../../lib/errors';
import { Logo } from '../layout/Logo';
import { ModeBanner } from '../layout/ModeBanner';
import { MainRegion, SkipLink } from '../layout/ShellParts';
import { Button, ButtonLink } from '../ui/Button';
import { OtpInput } from '../ui/CodeDigits';
import { InlineError } from '../ui/ErrorState';
import { Field } from '../ui/Field';
import { Icon } from '../ui/Icon';
import { Input } from '../ui/Input';
import { useDocumentTitle } from '../ui/PageHeader';
import { ThemeToggle } from '../ui/ThemeToggle';

export const MIN_ADMIN_PASSWORD = 8;

function AuthFrame({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="flex min-h-dvh flex-col page-glow">
      <SkipLink />
      <ModeBanner />
      <header className="flex items-center gap-3 px-[clamp(20px,4vw,48px)] py-6">
        <Logo />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle variant="outline" />
          <ButtonLink to="/signin?role=admin" variant="ghost" icon="arrow-left">
            Back to sign in
          </ButtonLink>
        </div>
      </header>
      <MainRegion className="flex flex-1 items-start justify-center px-5 py-10 sm:items-center">
        <div className="flex w-full max-w-[400px] animate-swap flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="lbl">RESTRICTED</p>
            <h1 className="text-[32px] leading-[1.1] text-fg">{title}</h1>
            <p className="text-[15px] text-fg-3">{subtitle}</p>
          </div>
          {children}
        </div>
      </MainRegion>
    </div>
  );
}

function SuccessBox({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-field border border-line bg-ok-bg px-4 py-3.5 text-sm text-fg-2">
      <Icon name="check-circle" size={18} className="mt-0.5 shrink-0 text-ok" />
      <div>{children}</div>
    </div>
  );
}

export function AdminForgotPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setError(new Error('Enter your work email address.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/admin/password/forgot', { method: 'POST', body: { email: value }, auth: false });
      setSentTo(value);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Reset your password" subtitle="We’ll email a one-time reset link. You’ll also need a code from your authenticator app.">
      {sentTo ? (
        <>
          <SuccessBox>
            If an admin account exists for <strong className="text-fg">{sentTo}</strong>, we’ve emailed a reset link. It expires in 30 minutes.
          </SuccessBox>
          <Button variant="outline" onClick={() => setSentTo(null)}>
            Use a different email
          </Button>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field label="Work email" required>
            <Input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <InlineError error={error} />
          <Button type="submit" size="lg" fullWidth loading={busy} className="h-[46px]">
            Send reset link
          </Button>
        </form>
      )}
      <p className="text-sm text-fg-3">Lost your authenticator? Contact a super admin.</p>
    </AuthFrame>
  );
}

function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

function resetError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'INVALID_CREDENTIALS') return 'This reset link is invalid or has expired, or the authenticator code is wrong.';
  return errorMessage(e);
}

export function AdminResetPasswordPage() {
  useNoReferrer();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Read once into memory, then strip it from the address bar / history.
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (params.has('token')) navigate(pathname, { replace: true, state: null });
  }, [params, pathname, navigate]);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; code?: string; form?: string }>({});

  if (!token) {
    return (
      <AuthFrame title="Reset link missing" subtitle="Open the link from your email again, or request a new one.">
        <ButtonLink to="/admin/forgot" size="lg" className="h-[46px]">
          Request a new link
        </ButtonLink>
      </AuthFrame>
    );
  }

  if (done) {
    return (
      <AuthFrame title="Password changed" subtitle="Every existing session was signed out.">
        <SuccessBox>Sign in with your new password and a fresh authenticator code.</SuccessBox>
        <ButtonLink to="/signin?role=admin" size="lg" className="h-[46px]">
          Go to sign in
        </ButtonLink>
      </AuthFrame>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (password.length < MIN_ADMIN_PASSWORD) next.password = `Use at least ${MIN_ADMIN_PASSWORD} characters.`;
    if (confirm !== password) next.confirm = 'The passwords don’t match.';
    if (!/^\d{6}$/.test(code)) next.code = 'Enter the 6-digit code from your authenticator app.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await api('/auth/admin/password/reset', { method: 'POST', body: { token, newPassword: password, totpCode: code }, auth: false });
      setDone(true);
    } catch (err) {
      const f = fieldErrors(err);
      setErrors({ password: f.newPassword, code: f.totpCode, form: f.newPassword || f.totpCode ? undefined : resetError(err) });
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Choose a new password" subtitle="Then confirm it’s you with a code from your authenticator app.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="New password" required hint={`At least ${MIN_ADMIN_PASSWORD} characters.`} error={errors.password}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm new password" required error={errors.confirm}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-fg">Code from your authenticator app</legend>
          <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(errors.code)} />
          {errors.code ? <InlineError error={new Error(errors.code)} /> : null}
        </fieldset>
        {errors.form ? <InlineError error={new Error(errors.form)} /> : null}
        <Button type="submit" size="lg" fullWidth loading={busy} className="h-[46px]">
          Change password
        </Button>
      </form>
      <p className="text-sm text-fg-3">
        Link expired? <Link to="/admin/forgot" className="font-medium text-fg underline underline-offset-2">Request a new one</Link>.
      </p>
    </AuthFrame>
  );
}
