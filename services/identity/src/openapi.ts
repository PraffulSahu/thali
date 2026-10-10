/** OpenAPI 3.1 document for identity — every route registered (served at `/openapi.json`, `/docs`). */
import { z } from 'zod';
import { createOpenApi, registerOpsRoutes } from '@thali/service-kit';
import {
  AddressListResponse,
  AddressViewSchema,
  AdminLoginBody,
  AdminLoginResponse,
  AdminMfaBody,
  AdminPasswordForgotBody,
  AdminPasswordForgotResponse,
  AdminPasswordResetBody,
  AvatarUploadBody,
  PresignedUploadResponse,
  AdminUsersQuery,
  AuditLogPageResponse,
  AuditLogsQuery,
  AuthTokensResponse,
  BlockBody,
  CreateAddressBody,
  CreateAdminBody,
  CreateAdminResponse,
  GrantRoleBody,
  GrantRoleResponse,
  IdParams,
  InternalUserSchema,
  JwksResponse,
  MfaEnableBody,
  MfaEnableResponse,
  MfaSetupResponse,
  NotificationPrefsSchema,
  OtpRequestBody,
  OtpRequestResponse,
  OtpVerifyBody,
  PatchAddressBody,
  PatchMeBody,
  UserPageResponse,
  UserViewSchema,
} from './schemas.js';

export function createIdentityOpenApi() {
  const openapi = createOpenApi('identity', {
    description:
      'Phone OTP auth, refresh-token sessions (cookie `thali_rt`, path /api/v1/auth), admin password + TOTP, profile/addresses, central audit log, JWKS.',
  });
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const ok = (description: string, schema: z.ZodType) => ({ 200: { description, content: json(schema) } });
  const noContent = { 204: { description: 'No content' } };
  const csrfHeaders = z.object({
    'x-requested-with': z.literal('thali-web'),
    origin: z.string().describe('Must be an allowed web origin'),
  });
  const cookieDoc = 'Reads the httpOnly refresh cookie `thali_rt` (path /api/v1/auth). CSRF: requires `X-Requested-With: thali-web` and an allowed `Origin`.';

  // ---- public auth ----
  openapi.route({
    method: 'post', path: '/api/v1/auth/otp/request', tags: ['auth'], summary: 'Send a login OTP to a phone',
    description: 'Limits: 30 s resend cooldown and 5/hour per phone, 20/hour per IP. In demo mode listed demo phones get code 123456 (no SMS).',
    request: { body: { content: json(OtpRequestBody) } },
    responses: ok('Code sent', OtpRequestResponse), rateLimited: true, errors: ['OTP_DELIVERY_FAILED', 'SERVICE_UNAVAILABLE'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/otp/verify', tags: ['auth'], summary: 'Verify OTP → access token + refresh cookie',
    description: 'Creates the user on first login (roles [CONSUMER]). Optional `guestCartToken` is merged best-effort (`guestCartMerged`). Sets `thali_rt`.',
    request: { body: { content: json(OtpVerifyBody) } },
    responses: ok('Signed in', AuthTokensResponse), rateLimited: true,
    errors: ['OTP_INVALID', 'OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED', 'ACCOUNT_BLOCKED'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/refresh', tags: ['auth'], summary: 'Rotate the refresh cookie and get a new access token',
    description: `${cookieDoc} Reuse of an old refresh token revokes the whole session (SESSION_REUSE_DETECTED).`,
    request: { headers: csrfHeaders },
    responses: ok('New access token (cookie rotated)', AuthTokensResponse),
    errors: ['UNAUTHENTICATED', 'SESSION_REVOKED', 'SESSION_REUSE_DETECTED', 'CSRF_CHECK_FAILED', 'ACCOUNT_BLOCKED'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/logout', tags: ['auth'], summary: 'Revoke the current session and clear the cookie',
    description: cookieDoc, request: { headers: csrfHeaders }, responses: noContent, errors: ['CSRF_CHECK_FAILED'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/logout-all', tags: ['auth'], summary: 'Revoke every session of the current user',
    security: 'bearer', responses: noContent,
  });

  // ---- admin auth ----
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/login', tags: ['admin-auth'], summary: 'Admin password login',
    description: 'Returns `{mfaRequired, mfaToken}` when TOTP is enabled, else `{mfaSetupRequired, accessToken}` (password-only; enrol TOTP next). 5 failures lock the account for 15 min. 10 attempts / 15 min per IP+email.',
    request: { body: { content: json(AdminLoginBody) } },
    responses: ok('Password accepted', AdminLoginResponse), rateLimited: true,
    errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'ACCOUNT_BLOCKED'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/mfa', tags: ['admin-auth'], summary: 'Complete admin login with a TOTP code',
    description: 'Exchanges the 5-minute mfaToken + TOTP for an access token (amr [pwd, mfa]) and a 12 h refresh cookie. A code can be used once.',
    request: { body: { content: json(AdminMfaBody) } },
    responses: ok('Signed in', AuthTokensResponse), rateLimited: true,
    errors: ['UNAUTHENTICATED', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'CONFLICT'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/password/forgot', tags: ['admin-auth'], summary: 'Request an admin password-reset email',
    description:
      'Always 202 with the same body, whether or not the email belongs to an admin (no account enumeration; the email is sent after the response). ' +
      'Eligible admins (active, not locked, TOTP enabled) get a single-use link `${PUBLIC_WEB_URL}/admin/reset-password?token=…` valid for 30 minutes; ' +
      'a new request replaces the previous link. Limits: 10 / 15 min per IP, 3 / 15 min per email. Audited (admin.password_reset_requested).',
    request: { body: { content: json(AdminPasswordForgotBody) } },
    responses: { 202: { description: 'Accepted', content: json(AdminPasswordForgotResponse) } }, rateLimited: true,
    errors: ['SERVICE_UNAVAILABLE'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/password/reset', tags: ['admin-auth'], summary: 'Set a new admin password with a reset token + current TOTP code',
    description:
      'Requires the token from the reset email, a valid unused TOTP code for that admin (wrong codes count toward the 5-failure lockout) and a password of at least 12 characters that differs from the current one. ' +
      'Consumes the token, revokes every session of the admin and is audited (admin.password_reset_completed). 10 attempts / 15 min per IP.',
    request: { body: { content: json(AdminPasswordResetBody) } },
    responses: noContent, rateLimited: true,
    errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'ACCOUNT_BLOCKED'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/mfa/setup', tags: ['admin-auth'], summary: 'Start TOTP enrolment (password-only admin token)',
    security: 'bearer', responses: ok('otpauth URI and secret', MfaSetupResponse), errors: ['CONFLICT'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/auth/admin/mfa/enable', tags: ['admin-auth'], summary: 'Confirm TOTP enrolment with a code',
    security: 'bearer', request: { body: { content: json(MfaEnableBody) } },
    responses: ok('Enabled', MfaEnableResponse), errors: ['INVALID_CREDENTIALS', 'CONFLICT', 'ACCOUNT_LOCKED'], rateLimited: true,
  });

  // ---- me ----
  openapi.route({ method: 'get', path: '/api/v1/me', tags: ['me'], summary: 'My profile', security: 'bearer', responses: ok('Profile', UserViewSchema), errors: ['NOT_FOUND'] });
  openapi.route({
    method: 'patch', path: '/api/v1/me', tags: ['me'], summary: 'Update name / email / avatar', security: 'bearer',
    description: '`avatarKey` must be a key from POST /api/v1/me/uploads after the file was PUT; the object is verified (size, jpeg/png/webp magic bytes) and deleted if invalid (422 FILE_INVALID). `null` removes the avatar.',
    request: { body: { content: json(PatchMeBody) } }, responses: ok('Profile', UserViewSchema), errors: ['CONFLICT', 'NOT_FOUND', 'FILE_INVALID'],
  });
  openapi.route({
    method: 'post', path: '/api/v1/me/uploads', tags: ['me'], summary: 'Presign an avatar upload (image/jpeg|png|webp ≤ 2 MB, public bucket)', security: 'bearer',
    description: 'PUT the file to `upload.url` with exactly `upload.headers`, then PATCH /api/v1/me `{avatarKey: key}`. 20 / hour per user.',
    request: { body: { content: json(AvatarUploadBody) } },
    responses: { 201: { description: 'Presigned PUT', content: json(PresignedUploadResponse) } }, errors: ['FILE_INVALID'], rateLimited: true,
  });
  openapi.route({ method: 'get', path: '/api/v1/me/addresses', tags: ['me'], summary: 'My saved addresses', security: 'bearer', responses: ok('Addresses', AddressListResponse) });
  openapi.route({
    method: 'post', path: '/api/v1/me/addresses', tags: ['me'], summary: 'Add an address (max 10; first or isDefault becomes the default)', security: 'bearer',
    request: { body: { content: json(CreateAddressBody) } },
    responses: { 201: { description: 'Created', content: json(AddressViewSchema) } },
  });
  openapi.route({
    method: 'patch', path: '/api/v1/me/addresses/:id', tags: ['me'], summary: 'Update one of my addresses', security: 'bearer',
    request: { params: IdParams, body: { content: json(PatchAddressBody) } }, responses: ok('Updated', AddressViewSchema), errors: ['NOT_FOUND'],
  });
  openapi.route({
    method: 'delete', path: '/api/v1/me/addresses/:id', tags: ['me'], summary: 'Delete one of my addresses', security: 'bearer',
    request: { params: IdParams }, responses: noContent, errors: ['NOT_FOUND'],
  });
  openapi.route({
    method: 'put', path: '/api/v1/me/notification-prefs', tags: ['me'], summary: 'Replace my notification preferences', security: 'bearer',
    request: { body: { content: json(NotificationPrefsSchema) } }, responses: ok('Saved', NotificationPrefsSchema),
  });

  // ---- admin ----
  openapi.route({
    method: 'get', path: '/api/v1/admin/users', tags: ['admin'], summary: 'Search users (ADMIN + MFA)', security: 'bearer',
    request: { query: AdminUsersQuery }, responses: ok('Page of users', UserPageResponse), errors: ['MFA_REQUIRED'],
  });
  openapi.route({
    method: 'get', path: '/api/v1/admin/users/:id', tags: ['admin'], summary: 'User detail (ADMIN + MFA)', security: 'bearer',
    request: { params: IdParams }, responses: ok('User', UserViewSchema), errors: ['MFA_REQUIRED', 'NOT_FOUND'],
  });
  for (const action of ['block', 'unblock'] as const) {
    openapi.route({
      method: 'post', path: `/api/v1/admin/users/:id/${action}`, tags: ['admin'],
      summary: `${action === 'block' ? 'Block (revokes all sessions)' : 'Unblock'} a user (ADMIN OPS/SUPPORT + MFA; audited)`, security: 'bearer',
      request: { params: IdParams, body: { content: json(BlockBody) } }, responses: ok('User', UserViewSchema),
      errors: ['MFA_REQUIRED', 'NOT_FOUND', 'CONFLICT'],
    });
  }
  openapi.route({
    method: 'post', path: '/api/v1/admin/admins', tags: ['admin'], summary: 'Create an admin (SUPER_ADMIN + MFA; audited)', security: 'bearer',
    request: { body: { content: json(CreateAdminBody) } },
    responses: { 201: { description: 'Created; one-time password shown once', content: json(CreateAdminResponse) } },
    errors: ['MFA_REQUIRED', 'CONFLICT'],
  });
  openapi.route({
    method: 'get', path: '/api/v1/admin/audit-logs', tags: ['admin'], summary: 'Central audit log (ADMIN + MFA)', security: 'bearer',
    request: { query: AuditLogsQuery }, responses: ok('Page of audit entries', AuditLogPageResponse), errors: ['MFA_REQUIRED'],
  });

  // ---- jwks ----
  openapi.route({ method: 'get', path: '/.well-known/jwks.json', tags: ['auth'], summary: 'Public keys for access-token verification', responses: ok('JWKS', JwksResponse) });

  // ---- internal ----
  openapi.route({
    method: 'get', path: '/internal/users/:id', tags: ['internal'], summary: 'User contact + prefs (notifications, delivery, marketplace, orders)',
    security: 'internal', request: { params: IdParams }, responses: ok('User', InternalUserSchema), errors: ['NOT_FOUND'],
  });
  openapi.route({
    method: 'post', path: '/internal/users/:id/roles', tags: ['internal'], summary: 'Grant RESTAURANT_OWNER / DELIVERY_PARTNER (idempotent; emits role.granted)',
    security: 'internal', request: { params: IdParams, body: { content: json(GrantRoleBody) } }, responses: ok('Roles', GrantRoleResponse), errors: ['NOT_FOUND'],
  });
  openapi.route({
    method: 'post', path: '/internal/users/:id/revoke-sessions', tags: ['internal'], summary: 'Revoke every session of a user',
    security: 'internal', request: { params: IdParams }, responses: noContent, errors: ['NOT_FOUND'],
  });
  registerOpsRoutes(openapi);
  return openapi;
}
