import './setup';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequireAuth, RequireRole } from '../src/components/layout/RequireRole';
import { makeAuth, renderWithProviders } from './utils';

describe('RequireRole', () => {
  it('anonymous -> sign-in prompt that preserves the current route', () => {
    renderWithProviders(
      <RequireRole role="RESTAURANT_OWNER">
        <p>secret board</p>
      </RequireRole>,
      { route: '/restaurant/orders?tab=new', auth: makeAuth() },
    );
    expect(screen.queryByText('secret board')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /sign in to continue/i })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link).toHaveAttribute('href', `/signin?next=${encodeURIComponent('/restaurant/orders?tab=new')}`);
  });

  it('honours a custom sign-in path (admin uses password login)', () => {
    renderWithProviders(
      <RequireRole role="ADMIN" signInPath="/admin/login">
        <p>admin</p>
      </RequireRole>,
      { route: '/admin/users', auth: makeAuth() },
    );
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      `/admin/login?next=${encodeURIComponent('/admin/users')}`,
    );
  });

  it('signed in without the role -> Forbidden state with a way out', () => {
    renderWithProviders(
      <RequireRole role="RESTAURANT_OWNER" forbiddenAction={{ label: 'Register your restaurant', to: '/restaurant/onboarding' }}>
        <p>secret board</p>
      </RequireRole>,
      { route: '/restaurant/orders', auth: makeAuth({ roles: ['CONSUMER'] }) },
    );
    expect(screen.queryByText('secret board')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /you don.t have access/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register your restaurant' })).toHaveAttribute('href', '/restaurant/onboarding');
    expect(screen.getByRole('link', { name: /go to home/i })).toHaveAttribute('href', '/');
  });

  it('signed in with the role -> renders children', () => {
    renderWithProviders(
      <RequireRole role="RESTAURANT_OWNER">
        <p>secret board</p>
      </RequireRole>,
      { auth: makeAuth({ roles: ['CONSUMER', 'RESTAURANT_OWNER'] }) },
    );
    expect(screen.getByText('secret board')).toBeInTheDocument();
  });

  it('while the session is being restored -> loading state, not a sign-in prompt', () => {
    renderWithProviders(
      <RequireRole role="ADMIN">
        <p>admin</p>
      </RequireRole>,
      { auth: makeAuth({ status: 'loading' }) },
    );
    expect(screen.getByRole('status')).toHaveTextContent(/checking your session/i);
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('ADMIN with requireMfa but no mfa amr -> sign-in prompt to finish verification', () => {
    renderWithProviders(
      <RequireRole role="ADMIN" requireMfa signInPath="/admin/login">
        <p>admin</p>
      </RequireRole>,
      { route: '/admin', auth: makeAuth({ roles: ['CONSUMER', 'ADMIN'], hasMfa: false }) },
    );
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /verify/i })).toHaveAttribute('href', `/admin/login?next=${encodeURIComponent('/admin')}`);
  });

  it('RequireAuth only needs a session', () => {
    renderWithProviders(
      <RequireAuth>
        <p>profile</p>
      </RequireAuth>,
      { auth: makeAuth({ roles: ['CONSUMER'] }) },
    );
    expect(screen.getByText('profile')).toBeInTheDocument();
  });
});
