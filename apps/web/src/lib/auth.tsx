/**
 * Authentication state for the whole SPA. Wrap the app in <AuthProvider> (inside QueryClientProvider)
 * and read it with `useAuth()`.
 *
 * Flows (LLD §5.1–5.3, identity routes in §10):
 *  - Boot: silent `POST /auth/refresh` (httpOnly cookie) restores the session; status starts 'loading'.
 *  - Consumer/owner/partner: `requestOtp(phone)` then `signInWithOtp(phone, code)`. The guest cart token
 *    (lib/guest) is sent automatically and merged; if the server reports `guestCartMerged: false` (or
 *    nothing), we call `POST /cart/merge` ourselves. On success the guest token is cleared.
 *  - Admin: `adminLogin(email, password)` resolves to one of
 *      { kind: 'mfaRequired', mfaToken }       -> call `adminVerifyMfa(mfaToken, code)`
 *      { kind: 'mfaSetupRequired', user }      -> a password-only token is stored; call `adminSetupMfa()`
 *                                                 (returns the otpauth URI) then `adminEnableMfa(code)`
 *      { kind: 'signedIn', user }              -> full session (defensive; normally MFA is required)
 *  - `refreshUser()` rotates the token to pick up newly granted roles (after restaurant/partner onboarding).
 *  - `signOut()` -> `POST /auth/logout`; `signOutEverywhere()` -> `POST /auth/logout-all`.
 *
 * Roles / admin roles / amr come from the access token claims (authoritative for the server), falling back
 * to `user.roles`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminRole, Role } from '@thali/contracts';
import {
  __resetApiForTests,
  api,
  getAccessToken,
  onAccessTokenChange,
  refreshSession,
  setAccessToken,
  type AuthTokenResponse,
} from './api';
import { ApiError } from './errors';
import { clearGuestCartToken, getGuestCartToken } from './guest';
import { decodeJwt } from './jwt';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthUser {
  id: string;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  roles?: Role[];
  adminRoles?: AdminRole[];
  [field: string]: unknown;
}

export interface OtpRequestResult {
  /** Seconds before another code may be requested (server value, default 30). */
  resendAfterSec: number;
  /** Seconds until the code expires, when the server reports it. */
  expiresInSec?: number;
  /** Demo mode fixed OTP is active for this phone. */
  demo: boolean;
  raw: unknown;
}

export type AdminLoginResult =
  | { kind: 'mfaRequired'; mfaToken: string }
  | { kind: 'mfaSetupRequired'; user: AuthUser | null }
  | { kind: 'signedIn'; user: AuthUser };

export interface MfaSetupResult {
  otpauthUri: string;
  /** Base32 secret for manual entry, if returned (else parse it from the URI's `secret` param). */
  secret?: string;
  raw: unknown;
}

export interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  user: AuthUser | null;
  roles: Role[];
  adminRoles: AdminRole[];
  /** Authentication methods of the current token, e.g. ['otp'] or ['pwd','mfa']. */
  amr: string[];
  hasMfa: boolean;
  hasRole(role: Role): boolean;
  requestOtp(phone: string): Promise<OtpRequestResult>;
  signInWithOtp(phone: string, code: string, guestCartToken?: string): Promise<AuthUser>;
  adminLogin(email: string, password: string): Promise<AdminLoginResult>;
  adminVerifyMfa(mfaToken: string, code: string): Promise<AuthUser>;
  adminSetupMfa(): Promise<MfaSetupResult>;
  /** Enables TOTP. `signedIn: false` means the server wants a fresh login (which will now ask for MFA). */
  adminEnableMfa(code: string): Promise<{ signedIn: boolean; raw: unknown }>;
  signOut(): Promise<void>;
  signOutEverywhere(): Promise<void>;
  refreshUser(): Promise<AuthUser>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ helpers */

function normalizeUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.user && typeof obj.user === 'object') return normalizeUser(obj.user);
  const id = obj.id ?? obj._id ?? obj.userId ?? obj.sub;
  if (typeof id !== 'string') return null;
  return { ...obj, id } as AuthUser;
}

function userFromToken(token: string | null): AuthUser | null {
  const c = decodeJwt(token);
  return c?.sub ? { id: c.sub, roles: c.roles ?? [], adminRoles: c.adm ?? [] } : null;
}

async function resolveUser(res: { user?: unknown } | null | undefined, token: string): Promise<AuthUser> {
  const fromResponse = normalizeUser(res?.user);
  if (fromResponse) return fromResponse;
  try {
    const me = normalizeUser(await api<unknown>('/me'));
    if (me) return me;
  } catch {
    /* fall back to claims below */
  }
  return userFromToken(token) ?? { id: 'unknown' };
}

function requireToken(res: AuthTokenResponse | Record<string, unknown> | null | undefined): string {
  const token = res && typeof res.accessToken === 'string' ? res.accessToken : null;
  if (!token) throw new ApiError({ code: 'INVALID_RESPONSE', status: 200, message: 'Sign-in response missing accessToken' });
  return token;
}

const num = (...v: unknown[]) => v.find((x): x is number => typeof x === 'number' && Number.isFinite(x));

let bootPromise: Promise<AuthTokenResponse | null> | null = null;
/** Single boot refresh per page load (StrictMode mounts effects twice; refresh tokens rotate). */
function bootOnce(): Promise<AuthTokenResponse | null> {
  if (!bootPromise) bootPromise = refreshSession().catch(() => null);
  return bootPromise;
}

/** Test-only: forget the boot refresh and api module state. */
export function __resetAuthForTests(): void {
  bootPromise = null;
  __resetApiForTests();
}

/* ------------------------------------------------------------------ provider */

interface State {
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>(() => ({ status: 'loading', user: null, token: getAccessToken() }));
  const flowRef = useRef(0); // >0 while a sign-in flow owns the state transitions

  // Keep in sync with the api token store (refresh, session expiry).
  useEffect(() => {
    return onAccessTokenChange((token) => {
      setState((s) => {
        if (!token) return { status: s.status === 'loading' ? 'loading' : 'anonymous', user: null, token: null };
        if (s.status === 'anonymous' && flowRef.current === 0) {
          return { status: 'authenticated', user: userFromToken(token), token };
        }
        return { ...s, token };
      });
    });
  }, []);

  // Boot: restore the session from the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    void bootOnce().then(async (res) => {
      if (cancelled) return;
      if (!res) {
        setState({ status: 'anonymous', user: null, token: null });
        return;
      }
      const user = await resolveUser(res, res.accessToken);
      if (!cancelled) setState({ status: 'authenticated', user, token: res.accessToken });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Proactively refresh ~60 s before expiry so users rarely hit a 401.
  useEffect(() => {
    const exp = decodeJwt(state.token)?.exp;
    if (!exp) return;
    const delay = Math.max(5_000, exp * 1000 - Date.now() - 60_000);
    const t = setTimeout(() => void refreshSession().catch(() => undefined), delay);
    return () => clearTimeout(t);
  }, [state.token]);

  const establish = useCallback(async (res: { user?: unknown }, token: string) => {
    setAccessToken(token);
    const user = await resolveUser(res, token);
    setState({ status: 'authenticated', user, token });
    return user;
  }, []);

  const withFlow = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    flowRef.current += 1;
    try {
      return await fn();
    } finally {
      flowRef.current -= 1;
    }
  }, []);

  const requestOtp = useCallback(async (phone: string): Promise<OtpRequestResult> => {
    const raw = await api<Record<string, unknown> | undefined>('/auth/otp/request', { method: 'POST', body: { phone }, auth: false });
    const r = raw ?? {};
    const expiresAt = typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : NaN;
    return {
      resendAfterSec: num(r.resendAfterSec, r.cooldownSec, r.retryAfterSec) ?? 30,
      expiresInSec: num(r.expiresInSec) ?? (Number.isNaN(expiresAt) ? undefined : Math.max(0, Math.round((expiresAt - Date.now()) / 1000))),
      demo: r.demoOtp === true || r.demo === true,
      raw,
    };
  }, []);

  const signInWithOtp = useCallback(
    (phone: string, code: string, guestCartToken: string | undefined = getGuestCartToken() ?? undefined) =>
      withFlow(async () => {
        const res = await api<AuthTokenResponse & { guestCartMerged?: boolean }>('/auth/otp/verify', {
          method: 'POST',
          body: { phone, code, ...(guestCartToken ? { guestCartToken } : {}) },
          auth: false,
          credentials: 'include',
        });
        const user = await establish(res, requireToken(res));
        if (guestCartToken) {
          if (res.guestCartMerged === true) clearGuestCartToken();
          else {
            try {
              await api('/cart/merge', { method: 'POST', body: { guestToken: guestCartToken } });
              clearGuestCartToken();
            } catch {
              /* keep the token; the cart page can retry the merge */
            }
          }
        }
        await queryClient.invalidateQueries();
        return user;
      }),
    [establish, queryClient, withFlow],
  );

  const adminLogin = useCallback(
    (email: string, password: string) =>
      withFlow(async (): Promise<AdminLoginResult> => {
        const res = await api<Record<string, unknown>>('/auth/admin/login', {
          method: 'POST',
          body: { email, password },
          auth: false,
          credentials: 'include',
        });
        if (res?.mfaRequired === true && typeof res.mfaToken === 'string') return { kind: 'mfaRequired', mfaToken: res.mfaToken };
        if (res?.mfaSetupRequired === true) {
          const token = typeof res.accessToken === 'string' ? res.accessToken : null;
          if (!token) return { kind: 'mfaSetupRequired', user: normalizeUser(res.user) };
          setAccessToken(token);
          const user = normalizeUser(res.user) ?? userFromToken(token);
          setState({ status: 'authenticated', user, token });
          return { kind: 'mfaSetupRequired', user };
        }
        const user = await establish(res, requireToken(res));
        return { kind: 'signedIn', user };
      }),
    [establish, withFlow],
  );

  const adminVerifyMfa = useCallback(
    (mfaToken: string, code: string) =>
      withFlow(async () => {
        const res = await api<AuthTokenResponse>('/auth/admin/mfa', {
          method: 'POST',
          body: { mfaToken, code },
          auth: false,
          credentials: 'include',
        });
        const user = await establish(res, requireToken(res));
        await queryClient.invalidateQueries();
        return user;
      }),
    [establish, queryClient, withFlow],
  );

  const adminSetupMfa = useCallback(async (): Promise<MfaSetupResult> => {
    const raw = await api<Record<string, unknown>>('/auth/admin/mfa/setup', { method: 'POST', credentials: 'include' });
    const uri = [raw?.otpauthUri, raw?.otpauthUrl, raw?.otpauth, raw?.uri].find((v): v is string => typeof v === 'string');
    if (!uri) throw new ApiError({ code: 'INVALID_RESPONSE', status: 200, message: 'MFA setup response missing otpauth URI' });
    let secret = typeof raw.secret === 'string' ? raw.secret : undefined;
    if (!secret) {
      try {
        secret = new URL(uri).searchParams.get('secret') ?? undefined;
      } catch {
        secret = undefined;
      }
    }
    return { otpauthUri: uri, secret, raw };
  }, []);

  const adminEnableMfa = useCallback(
    (code: string) =>
      withFlow(async () => {
        const raw = await api<Record<string, unknown> | undefined>('/auth/admin/mfa/enable', {
          method: 'POST',
          body: { code },
          credentials: 'include',
        });
        if (raw && typeof raw.accessToken === 'string') {
          await establish(raw, raw.accessToken);
          return { signedIn: true, raw };
        }
        return { signedIn: false, raw };
      }),
    [establish, withFlow],
  );

  const endSession = useCallback(
    async (path: '/auth/logout' | '/auth/logout-all') => {
      try {
        await api(path, { method: 'POST', credentials: 'include' });
      } catch {
        /* the local session ends regardless */
      } finally {
        setAccessToken(null);
        setState({ status: 'anonymous', user: null, token: null });
        queryClient.clear();
      }
    },
    [queryClient],
  );
  const signOut = useCallback(() => endSession('/auth/logout'), [endSession]);
  const signOutEverywhere = useCallback(() => endSession('/auth/logout-all'), [endSession]);

  const refreshUser = useCallback(async () => {
    const res = await refreshSession();
    const user = await resolveUser(res, res.accessToken);
    setState({ status: 'authenticated', user, token: res.accessToken });
    return user;
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const claims = decodeJwt(state.token);
    const roles: Role[] = claims?.roles ?? state.user?.roles ?? [];
    const adminRoles: AdminRole[] = claims?.adm ?? state.user?.adminRoles ?? [];
    const amr = claims?.amr ?? [];
    const isAuthenticated = state.status === 'authenticated';
    return {
      status: state.status,
      isAuthenticated,
      user: state.user,
      roles,
      adminRoles,
      amr,
      hasMfa: amr.includes('mfa'),
      hasRole: (role: Role) => isAuthenticated && roles.includes(role),
      requestOtp,
      signInWithOtp,
      adminLogin,
      adminVerifyMfa,
      adminSetupMfa,
      adminEnableMfa,
      signOut,
      signOutEverywhere,
      refreshUser,
    };
  }, [state, requestOtp, signInWithOtp, adminLogin, adminVerifyMfa, adminSetupMfa, adminEnableMfa, signOut, signOutEverywhere, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
