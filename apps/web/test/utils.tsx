/**
 * Test helpers for web tests (shared with the role-area implementers).
 *
 *   import { renderWithProviders, makeAuth, makeJwt } from '../utils';
 *   renderWithProviders(<MyPage />, { route: '/restaurant/orders', auth: makeAuth({ roles: ['CONSUMER', 'RESTAURANT_OWNER'] }) });
 *
 * - wraps in a fresh QueryClient (no retries), ToastProvider, a fake AuthContext and a MemoryRouter.
 * - `auth` is a partial AuthContextValue; anything omitted gets a safe default (anonymous unless `user`/`roles` given).
 * - `path` lets you mount the element under a route pattern (e.g. '/orders/:id') so useParams works.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { Role } from '@thali/contracts';
import { AuthContext, type AuthContextValue, type AuthUser } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui/Toast';

export function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64(claims)}.sig`;
}

export function makeAuth(overrides: Partial<AuthContextValue> & { roles?: Role[] } = {}): AuthContextValue {
  const signedIn = Boolean(overrides.user ?? overrides.roles);
  const roles: Role[] = overrides.roles ?? (signedIn ? ['CONSUMER'] : []);
  const user: AuthUser | null = overrides.user ?? (signedIn ? { id: 'u1', name: 'Test User', phone: '+919876543210', roles } : null);
  return {
    status: signedIn ? 'authenticated' : 'anonymous',
    isAuthenticated: signedIn,
    user,
    roles,
    adminRoles: [],
    amr: signedIn ? ['otp'] : [],
    hasMfa: false,
    hasRole: (r: Role) => roles.includes(r),
    requestOtp: vi.fn(),
    signInWithOtp: vi.fn(),
    adminLogin: vi.fn(),
    adminVerifyMfa: vi.fn(),
    adminSetupMfa: vi.fn(),
    adminEnableMfa: vi.fn(),
    signOut: vi.fn(),
    signOutEverywhere: vi.fn(),
    refreshUser: vi.fn(),
    ...overrides,
  } as AuthContextValue;
}

export interface ProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
  path?: string;
  auth?: AuthContextValue;
  queryClient?: QueryClient;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

export function renderWithProviders(ui: ReactElement, opts: ProvidersOptions = {}) {
  const { route = '/', path = '*', auth = makeAuth(), queryClient = makeQueryClient(), ...rest } = opts;
  const router = createMemoryRouter([{ path, element: ui }], { initialEntries: [route] });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <ToastProvider>{children}</ToastProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
  return { router, queryClient, ...render(<RouterProvider router={router} />, { wrapper: Wrapper, ...rest }) };
}
