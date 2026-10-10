import '../setup';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminLogin from '../../src/features/admin/AdminLogin';
import { ApiError } from '../../src/lib/errors';
import { makeAuth, renderWithProviders } from '../utils';

async function fillCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email/i), 'ops@thali.test');
  await user.type(screen.getByLabelText(/password/i), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

describe('AdminLogin', () => {
  it('shows the MFA step after the password is accepted, then verifies the code', async () => {
    const user = userEvent.setup();
    const adminLogin = vi.fn().mockResolvedValue({ kind: 'mfaRequired', mfaToken: 'mfa-token-1' });
    const adminVerifyMfa = vi.fn().mockResolvedValue({ id: 'a1' });
    renderWithProviders(<AdminLogin />, { route: '/admin/login?next=/admin/health', auth: makeAuth({ adminLogin, adminVerifyMfa }) });

    expect(screen.queryByLabelText(/authenticator code/i)).not.toBeInTheDocument();
    await fillCredentials(user);

    expect(adminLogin).toHaveBeenCalledWith('ops@thali.test', 'correct horse battery');
    const code = await screen.findByLabelText(/authenticator code/i);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: /verify and sign in/i }));
    await waitFor(() => expect(adminVerifyMfa).toHaveBeenCalledWith('mfa-token-1', '123456'));
  });

  it('shows the otpauth URI and manual key when the account must set up MFA', async () => {
    const user = userEvent.setup();
    const adminLogin = vi.fn().mockResolvedValue({ kind: 'mfaSetupRequired', user: null });
    const adminSetupMfa = vi.fn().mockResolvedValue({
      otpauthUri: 'otpauth://totp/Thali:ops@thali.test?secret=JBSWY3DPEHPK3PXP&issuer=Thali',
      secret: 'JBSWY3DPEHPK3PXP',
      raw: {},
    });
    renderWithProviders(<AdminLogin />, { route: '/admin/login', auth: makeAuth({ adminLogin, adminSetupMfa }) });
    await fillCredentials(user);

    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText(/otpauth:\/\/totp\/Thali:ops@thali\.test/)).toBeInTheDocument();
    expect(screen.getByLabelText(/authenticator code/i)).toBeInTheDocument();
  });

  it('explains an account lockout without revealing anything else', async () => {
    const user = userEvent.setup();
    const adminLogin = vi.fn().mockRejectedValue(
      new ApiError({ code: 'ACCOUNT_LOCKED', status: 423, message: 'Too many failed attempts.', details: { lockedUntil: '2026-10-10T10:30:00.000Z' } }),
    );
    renderWithProviders(<AdminLogin />, { route: '/admin/login', auth: makeAuth({ adminLogin }) });
    await fillCredentials(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/locked/i);
    expect(screen.queryByLabelText(/authenticator code/i)).not.toBeInTheDocument();
  });
});
