import './setup';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredDialog } from '../src/components/layout/SessionExpired';
import { api, setAccessToken } from '../src/lib/api';
import { renderWithProviders } from './utils';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('SessionExpiredDialog', () => {
  it('opens when a session cannot be refreshed, focuses "Sign in again" and keeps the route as next', async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<SessionExpiredDialog />, { route: '/orders/abc?tab=live' });
    setAccessToken('old');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
        .mockResolvedValueOnce(json(401, { error: { code: 'SESSION_REVOKED', message: 'revoked', requestId: 'r2' } })),
    );
    await act(async () => {
      await api('/orders/abc').catch(() => undefined);
    });

    const dialog = await screen.findByRole('alertdialog', { name: 'Session expired — sign in again' });
    const signIn = screen.getByRole('button', { name: 'Sign in again' });
    expect(dialog).toContainElement(signIn);
    expect(signIn).toHaveFocus();

    await user.click(signIn);
    expect(router.state.location.pathname).toBe('/signin');
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/orders/abc?tab=live')}`);
  });
});
