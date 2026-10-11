/**
 * Unified sign-in — board 01 (design-spec §5.01): `/signin?role=customer|restaurant|partner|admin&next=/path`.
 * Customer / Restaurant / Partner: phone OTP (OtpSignInForm). Admin: email + password + authenticator code
 * (AdminSignInForm, "Forgot?" → /admin/forgot). After sign-in we route by role (lib/signin) and honour `next`.
 * `/admin/login` redirects here with role=admin (routes.tsx).
 */
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { getAccessToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { destinationAfterSignIn, parseSignInRole, rolesFromSignIn, safeRelative, type SignInRole } from '../../lib/signin';
import { Logo } from '../layout/Logo';
import { ModeBanner } from '../layout/ModeBanner';
import { SessionLoading } from '../layout/RequireRole';
import { MainRegion, SkipLink } from '../layout/ShellParts';
import { ButtonLink } from '../ui/Button';
import { useDocumentTitle } from '../ui/PageHeader';
import { SegmentedTabs } from '../ui/SegmentedTabs';
import { ThemeToggle } from '../ui/ThemeToggle';
import { AdminSignInForm } from './AdminSignInForm';
import { OtpSignInForm } from './OtpSignInForm';

/** Only allow same-origin relative paths as redirect targets (no open redirects). */
export function safeNext(raw: string | null, fallback = '/'): string {
  return safeRelative(raw) ?? fallback;
}

interface RoleCopy {
  tab: string;
  title: string;
  subtitle: string;
  foot: ReactNode;
  tag: string;
  headline: ReactNode;
  points: Array<[string, string]>;
}

const COPY: Record<SignInRole, RoleCopy> = {
  customer: {
    tab: 'Customer',
    title: 'Welcome back',
    subtitle: 'Sign in to check out, track orders and manage addresses.',
    foot: (
      <>
        Just browsing? You don’t need an account. <FootLink to="/discover">Explore restaurants →</FootLink>
      </>
    ),
    tag: 'CUSTOMER',
    headline: (
      <>
        Your cart comes <span className="accent-word">with you.</span>
      </>
    ),
    points: [
      ['Cart kept on sign-in', 'Anything you added as a guest is merged into your account.'],
      ['Track every kitchen', 'Each restaurant has its own status, rider and delivery code.'],
      ['Refunds to the rupee', 'Paid, refunded and pending are always shown separately.'],
    ],
  },
  restaurant: {
    tab: 'Restaurant',
    title: 'Restaurant sign in',
    subtitle: 'Use the phone number registered as the restaurant owner.',
    foot: (
      <>
        New to Thali? <FootLink to="/signin?role=restaurant&next=%2Frestaurant%2Fonboarding" replaceTo="/restaurant/onboarding">List your restaurant →</FootLink>
      </>
    ),
    tag: 'RESTAURANT OWNER',
    headline: (
      <>
        Run the counter <span className="accent-word">from here.</span>
      </>
    ),
    points: [
      ['Live orders', 'Chime + countdown on every new order. Accept with a prep time.'],
      ['Menu and stock', 'Toggle availability in one tap. Stock can’t go below reserved.'],
      ['Earnings and payouts', 'Every payout marked Paid carries its bank UTR.'],
    ],
  },
  partner: {
    tab: 'Partner',
    title: 'Partner sign in',
    subtitle: 'Use the phone number on your partner profile.',
    foot: (
      <>
        Want to deliver with Thali? <FootLink to="/signin?role=partner&next=%2Fpartner%2Fonboarding" replaceTo="/partner/onboarding">Apply to ride →</FootLink>
      </>
    ),
    tag: 'DELIVERY PARTNER',
    headline: (
      <>
        Ready when <span className="accent-word">you are.</span>
      </>
    ),
    points: [
      ['Go online in one tap', 'Location is shared only while you’re online.'],
      ['Offers you can judge', 'Distance, time and why a second order fits — before you accept.'],
      ['Codes at each handover', 'Pickup code at the restaurant, delivery code at the door.'],
    ],
  },
  admin: {
    tab: 'Admin',
    title: 'Operations sign in',
    subtitle: 'Email and password, then a code from your authenticator app.',
    foot: <>Lost your authenticator? Contact a super admin.</>,
    tag: 'RESTRICTED',
    headline: (
      <>
        Thali <span className="accent-word">operations.</span>
      </>
    ),
    points: [
      ['MFA required', 'Every session needs a fresh 6-digit TOTP code.'],
      ['Everything is audited', 'Approvals, refunds and payouts are logged with who, when and IP.'],
      ['Role-based actions', 'Ops, Finance and Support see only the actions they can take.'],
    ],
  },
};

/** Foot link; when the user is already signed in, links straight to `replaceTo`. */
function FootLink({ to, replaceTo, children }: { to: string; replaceTo?: string; children: ReactNode }) {
  const auth = useAuth();
  return (
    <Link to={auth.isAuthenticated && replaceTo ? replaceTo : to} className="font-medium text-fg underline underline-offset-2 hover:text-acc-fg">
      {children}
    </Link>
  );
}

function Points({ points, compact }: { points: RoleCopy['points']; compact?: boolean }) {
  return (
    <ol className={cn('overflow-hidden rounded-card border border-line bg-card', compact && 'bg-transparent')}>
      {points.map(([title, body], i) => (
        <li key={title} className="flex gap-3.5 border-b border-line px-[18px] py-4 last:border-0">
          <span className="pt-0.5 font-mono text-xs text-fg-3">{String(i + 1).padStart(2, '0')}</span>
          <span className="flex flex-col gap-1">
            <span className="text-[15px] font-medium text-fg">{title}</span>
            <span className="text-[13px] text-fg-3">{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function SignInPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const role = parseSignInRole(params.get('role'));
  const rawNext = params.get('next') ?? params.get('returnTo');
  const copy = COPY[role];
  const [formKey, setFormKey] = useState(0);
  useDocumentTitle(role === 'admin' ? 'Operations sign in' : 'Sign in');

  if (auth.status === 'loading') return <SessionLoading />;
  const done = auth.isAuthenticated && (role !== 'admin' || (auth.hasRole('ADMIN') && auth.hasMfa));
  if (done) return <Navigate to={destinationAfterSignIn(role, auth.roles, rawNext)} replace />;

  const finish = (user?: Parameters<typeof rolesFromSignIn>[0]) =>
    navigate(destinationAfterSignIn(role, rolesFromSignIn(user ?? auth.user, getAccessToken()), rawNext), { replace: true });

  const switchRole = (next: SignInRole) => {
    const p = new URLSearchParams(params);
    p.set('role', next);
    p.delete('returnTo');
    if (rawNext) p.set('next', rawNext);
    setParams(p, { replace: true });
    setFormKey((k) => k + 1);
  };

  const backTo = '/';

  return (
    <div className="flex min-h-dvh flex-col page-glow">
      <SkipLink />
      <ModeBanner />
      <div className="flex flex-1 flex-wrap">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col px-[clamp(20px,4vw,48px)] py-6">
          <header className="flex items-center gap-3">
            <Logo />
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle variant="outline" />
              <ButtonLink to={backTo} variant="ghost" icon="arrow-left">
                Back to site
              </ButtonLink>
            </div>
          </header>
          <MainRegion className="flex flex-1 items-center justify-center py-10">
            <div className="flex w-full max-w-[400px] flex-col gap-6">
              <div key={`t-${role}`} className="flex animate-swap flex-col gap-2">
                <h1 className="text-[32px] leading-[1.1] text-fg max-sm:text-[28px]">{copy.title}</h1>
                <p className="text-[15px] text-fg-3">{copy.subtitle}</p>
              </div>
              <SegmentedTabs
                label="Sign in as"
                fullWidth
                value={role}
                onChange={switchRole}
                options={(Object.keys(COPY) as SignInRole[]).map((r) => ({ value: r, label: COPY[r].tab }))}
              />
              <div key={`${role}-${formKey}`} className="animate-swap">
                {role === 'admin' ? <AdminSignInForm onSignedIn={() => finish()} /> : <OtpSignInForm onSuccess={(u) => finish(u)} />}
              </div>
              <hr className="border-line" />
              <p className="text-sm leading-relaxed text-fg-3">{copy.foot}</p>
              <div className="lg:hidden">
                <Points points={copy.points} compact />
              </div>
            </div>
          </MainRegion>
          <p className="text-[12.5px] text-fg-3">
            By continuing you agree to Thali’s{' '}
            <Link to="/terms" className="underline underline-offset-2 hover:text-fg">
              Terms
            </Link>{' '}
            and{' '}
            <Link to="/privacy" className="underline underline-offset-2 hover:text-fg">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
        <aside
          aria-label={`${copy.tab} sign-in`}
          className="relative hidden min-w-0 flex-[1_1_520px] items-center justify-center overflow-hidden border-l border-line bg-side px-10 py-16 backdrop-blur-[6px] grid-bg lg:flex"
        >
          <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(60%_55%_at_75%_15%,var(--acc-soft),transparent_70%)]" />
          <div key={role} className="relative flex w-full max-w-[440px] animate-swap flex-col gap-7">
            <p className="lbl">{copy.tag}</p>
            <h2 className="text-[clamp(32px,3.4vw,44px)] leading-[1.05] text-fg">{copy.headline}</h2>
            <Points points={copy.points} />
          </div>
        </aside>
      </div>
    </div>
  );
}
