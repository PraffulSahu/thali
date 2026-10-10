/**
 * Route/content guards. The server enforces everything; these decide what to render.
 *
 *   <RequireAuth><ProfilePage /></RequireAuth>                         any signed-in user
 *   <RequireRole role="RESTAURANT_OWNER"
 *     forbiddenAction={{ label: 'Register your restaurant', to: '/restaurant/onboarding' }}>…</RequireRole>
 *   <RequireRole role="ADMIN" requireMfa signInPath="/admin/login">…</RequireRole>
 *
 * States: session restoring -> "Checking your session…" (role="status"); anonymous -> "Sign in to continue"
 * with a link to `${signInPath}?next=<current path>`; ADMIN without MFA (requireMfa) -> "Verify to continue";
 * signed in without the role -> <ForbiddenState> (with optional action + "Go to home").
 * `role` may be an array: any one of them passes.
 */
import type { ReactNode } from 'react';
import type { Role } from '@thali/contracts';
import { useAuth } from '../../lib/auth';
import { ButtonLink } from '../ui/Button';
import { ForbiddenState, useSignInHref } from '../ui/ErrorState';
import { Icon } from '../ui/Icon';
import { Spinner } from '../ui/Spinner';

export interface RequireRoleProps {
  role?: Role | Role[];
  children: ReactNode;
  signInPath?: string;
  requireMfa?: boolean;
  forbiddenAction?: { label: string; to: string };
  forbiddenTitle?: string;
  forbiddenMessage?: string;
  /** Copy for the anonymous prompt. */
  signInMessage?: string;
}

export function SessionLoading() {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-24 text-slate-600">
      <Spinner label={null} size={22} />
      <span>Checking your session…</span>
    </div>
  );
}

export function SignInPrompt({
  signInPath = '/signin',
  title = 'Sign in to continue',
  message = 'Sign in with your phone number to see this page.',
  cta = 'Sign in',
}: {
  signInPath?: string;
  title?: string;
  message?: string;
  cta?: string;
}) {
  const href = useSignInHref(signInPath);
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-brand-50 text-brand-700">
        <Icon name="user" size={26} />
      </span>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="max-w-prose text-[0.9375rem] text-slate-600">{message}</p>
      <ButtonLink to={href} className="mt-2">
        {cta}
      </ButtonLink>
    </div>
  );
}

export function RequireRole({
  role, children, signInPath = '/signin', requireMfa, forbiddenAction, forbiddenTitle, forbiddenMessage, signInMessage,
}: RequireRoleProps) {
  const auth = useAuth();
  if (auth.status === 'loading') return <SessionLoading />;
  if (!auth.isAuthenticated) return <SignInPrompt signInPath={signInPath} message={signInMessage} />;
  const roles = role === undefined ? [] : Array.isArray(role) ? role : [role];
  const allowed = roles.length === 0 || roles.some((r) => auth.hasRole(r));
  if (!allowed) {
    return <ForbiddenState action={forbiddenAction} title={forbiddenTitle} message={forbiddenMessage} />;
  }
  if (requireMfa && !auth.hasMfa) {
    return (
      <SignInPrompt
        signInPath={signInPath}
        title="Verify to continue"
        message="Admin pages need two-factor verification. Sign in with your password and authenticator code."
        cta="Verify with authenticator"
      />
    );
  }
  return <>{children}</>;
}

export function RequireAuth(props: Omit<RequireRoleProps, 'role'>) {
  return <RequireRole {...props} />;
}
