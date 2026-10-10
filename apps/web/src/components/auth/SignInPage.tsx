/**
 * `/signin?next=/path` — shared phone-OTP sign-in for consumers, restaurant owners and partners.
 * Guards and the session-expired dialog send users here with `next` so they come back to the same route.
 * Admins use `/admin/login` (owned by the admin area).
 */
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../lib/auth';
import { SkipLink } from '../layout/AppShell';
import { Logo } from '../layout/Logo';
import { ModeBanner } from '../layout/ModeBanner';
import { SessionLoading } from '../layout/RequireRole';
import { Card } from '../ui/Card';
import { useDocumentTitle } from '../ui/PageHeader';
import { OtpSignInForm } from './OtpSignInForm';

/** Only allow same-origin relative paths as redirect targets (no open redirects). */
export function safeNext(raw: string | null, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}

export default function SignInPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  useDocumentTitle('Sign in');

  if (auth.status === 'loading') return <SessionLoading />;
  if (auth.isAuthenticated) return <Navigate to={next} replace />;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <ModeBanner />
      <header className="mx-auto flex h-16 w-full max-w-content items-center px-4">
        <Logo />
      </header>
      <main id="main" tabIndex={-1} className="flex flex-1 items-start justify-center px-4 py-8 focus:outline-none sm:items-center">
        <div className="w-full max-w-md">
          <Card padding="lg">
            <OtpSignInForm heading="Sign in to Thali" onSuccess={() => navigate(next, { replace: true })} />
          </Card>
          <p className="mt-6 text-center text-sm text-slate-600">
            New here? Signing in creates your account. Restaurant owners and delivery partners sign in the same way.
          </p>
        </div>
      </main>
    </div>
  );
}
