/**
 * Authenticator enrolment (LLD §5.3). No QR library is bundled, so the otpauth URI and the manual key are
 * shown as text: copy the key into any authenticator app ("enter a setup key", time-based, 6 digits), or
 * open the URI on a phone that handles otpauth links. The code field confirms the app is in sync.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { ErrorState, InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function TotpCodeField({ value, onChange, label = 'Authenticator code', error }: { value: string; onChange: (v: string) => void; label?: string; error?: string }) {
  return (
    <Field label={label} required hint="The 6-digit code from your authenticator app" error={error}>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456"
        className="tracking-[0.35em] tabular-nums"
      />
    </Field>
  );
}

export interface MfaSetupProps {
  /** Called with the code; throw to show the error inline. */
  onEnable: (code: string) => Promise<void>;
}

export default function MfaSetup({ onEnable }: MfaSetupProps) {
  const auth = useAuth();
  const { toast } = useToast();
  // Setup replaces the server-side secret, so it must run exactly once per mount (query de-dupes StrictMode).
  const setup = useQuery({
    queryKey: ['admin', 'mfa-setup'],
    queryFn: () => auth.adminSetupMfa(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (setup.isPending) return <p role="status" className="text-sm text-slate-600">Preparing your authenticator setup…</p>;
  if (setup.isError) return <ErrorState compact error={setup.error} title="Couldn't start authenticator setup" onRetry={() => setup.refetch()} />;

  const { otpauthUri, secret } = setup.data;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onEnable(code);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const doCopy = async (text: string, what: string) =>
    toast(await copy(text) ? { title: `${what} copied`, tone: 'success' } : { title: `Couldn't copy ${what.toLowerCase()}`, description: 'Select the text and copy it manually.', tone: 'warn' });

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-[0.9375rem] text-slate-800">
        <li>
          <p>Open an authenticator app (Google Authenticator, Authy, 1Password…) and add an account using a <strong>setup key</strong>.</p>
          {secret ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-slate-200 bg-surface-muted p-3">
              <span className="text-sm text-slate-600">Setup key</span>
              <code className="select-all break-all font-mono text-base font-semibold tracking-wider text-slate-900">{secret}</code>
              <Button type="button" size="sm" variant="secondary" icon="list" onClick={() => void doCopy(secret, 'Setup key')}>
                Copy key
              </Button>
            </div>
          ) : null}
          <p className="mt-2 text-sm text-slate-600">Choose time-based codes, 6 digits, 30 seconds.</p>
        </li>
        <li>
          <p>Or open this link on a phone that handles authenticator links:</p>
          <div className="mt-2 flex flex-col gap-2 rounded-control border border-slate-200 bg-surface-muted p-3">
            <code className="select-all break-all font-mono text-xs text-slate-800">{otpauthUri}</code>
            <div>
              <Button type="button" size="sm" variant="secondary" onClick={() => void doCopy(otpauthUri, 'Setup link')}>
                Copy link
              </Button>
            </div>
          </div>
        </li>
        <li>Enter the 6-digit code your app now shows to finish enabling two-factor sign-in.</li>
      </ol>
      <TotpCodeField value={code} onChange={setCode} />
      <InlineError error={error} />
      <Button type="submit" loading={busy} disabled={code.length !== 6} fullWidth>
        Enable and continue
      </Button>
    </form>
  );
}
