/**
 * Identity request/response schemas (validation + OpenAPI). Names via `.meta({ id })`.
 */
import { z } from 'zod';
import {
  AddressSchema,
  AdminLoginSchema,
  AdminMfaSchema,
  AdminRoleSchema,
  GeoPointSchema,
  ObjectIdSchema,
  OtpCodeSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PincodeSchema,
  RoleSchema,
} from '@thali/contracts';
import { MIN_ADMIN_PASSWORD_LENGTH } from './domain/constants.js';

export const IdParams = z.object({ id: z.string().min(1).max(64) });

export const NotificationPrefsSchema = z
  .object({ orderSms: z.boolean(), orderEmail: z.boolean(), marketingSms: z.boolean(), marketingEmail: z.boolean() })
  .strict()
  .meta({ id: 'NotificationPrefs' });

export const AddressViewSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    line1: z.string(),
    line2: z.string().nullable(),
    landmark: z.string().nullable(),
    locality: z.string().nullable().describe('Neighbourhood, e.g. "Indiranagar" (header chip, delivery drop area)'),
    formattedAddress: z.string().nullable().describe('Provider-formatted full address (display only)'),
    city: z.string(),
    pincode: z.string(),
    location: GeoPointSchema,
    isDefault: z.boolean(),
  })
  .meta({ id: 'SavedAddress' });

export const UserViewSchema = z
  .object({
    id: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable().describe('Resolved avatar image URL; null = show initials'),
    roles: z.array(RoleSchema),
    adminRoles: z.array(AdminRoleSchema),
    status: z.enum(['ACTIVE', 'BLOCKED']),
    notificationPrefs: NotificationPrefsSchema,
    addresses: z.array(AddressViewSchema),
    createdAt: z.string(),
  })
  .meta({ id: 'User' });

export const InternalUserSchema = z
  .object({
    id: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    roles: z.array(RoleSchema),
    status: z.enum(['ACTIVE', 'BLOCKED']),
    notificationPrefs: NotificationPrefsSchema,
  })
  .meta({ id: 'InternalUser' });

// ---- auth ----
export const OtpRequestBody = OtpRequestSchema.meta({ id: 'OtpRequest', example: { phone: '+91 98765 43210' } });
export const OtpRequestResponse = z
  .object({
    status: z.literal('SENT'),
    expiresAt: z.string(),
    resendAfterSec: z.number().int(),
    demoOtp: z.literal(true).optional().describe('Demo mode only: code is 123456 and no SMS was sent'),
  })
  .meta({ id: 'OtpRequestResult' });
export const OtpVerifyBody = OtpVerifySchema.meta({
  id: 'OtpVerify',
  example: { phone: '+919876543210', code: '482913', guestCartToken: 'optional-guest-cart-token' },
});
export const AuthTokensResponse = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresInSec: z.number().int(),
    user: UserViewSchema,
    guestCartMerged: z.boolean().optional(),
    demoOtp: z.literal(true).optional(),
  })
  .meta({ id: 'AuthTokens' });

export const AdminLoginBody = AdminLoginSchema.meta({ id: 'AdminLogin' });
export const AdminLoginResponse = z
  .union([
    z.object({ mfaRequired: z.literal(true), mfaToken: z.string(), expiresInSec: z.number().int() }),
    z.object({
      mfaSetupRequired: z.literal(true),
      accessToken: z.string().describe('Password-only token (amr=[pwd]); valid only for /auth/admin/mfa/setup|enable'),
      tokenType: z.literal('Bearer'),
      expiresInSec: z.number().int(),
      user: UserViewSchema,
    }),
  ])
  .meta({ id: 'AdminLoginResult' });
export const AdminMfaBody = AdminMfaSchema.meta({ id: 'AdminMfa' });
export const MfaSetupResponse = z.object({ otpauthUri: z.string(), secret: z.string() }).meta({ id: 'MfaSetup' });
export const MfaEnableBody = z.object({ code: OtpCodeSchema }).meta({ id: 'MfaEnable' });
export const MfaEnableResponse = z.object({ enabled: z.literal(true) }).meta({ id: 'MfaEnabled' });

/** IDN-1 */
export const AdminPasswordForgotBody = z.object({ email: z.email().max(254) }).meta({ id: 'AdminPasswordForgot' });
export const AdminPasswordForgotResponse = z
  .object({ status: z.literal('ACCEPTED') })
  .meta({ id: 'AdminPasswordForgotAccepted', description: 'Always returned, whether or not the email belongs to an admin' });
export const AdminPasswordResetBody = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid reset token').describe('The token from the reset link (32 random bytes, base64url)'),
    newPassword: z
      .string()
      .min(MIN_ADMIN_PASSWORD_LENGTH, `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`)
      .max(256),
    totpCode: OtpCodeSchema.describe('Current code from the admin authenticator app'),
  })
  .strict()
  .meta({ id: 'AdminPasswordReset' });

// ---- me ----
/** Only keys from `POST /me/uploads` (never absolute URLs). */
export const AVATAR_KEY_RE = /^users\/[0-9a-f]{24}\/avatars\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/;
export const PatchMeBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.email().max(254).transform((e) => e.toLowerCase()).optional(),
    avatarKey: z
      .string()
      .regex(AVATAR_KEY_RE, 'Use the key returned by POST /api/v1/me/uploads')
      .nullable()
      .optional()
      .describe('Key from POST /me/uploads after the PUT (content is verified); null removes the avatar'),
  })
  .strict()
  .meta({ id: 'PatchMe' });
export const CreateAddressBody = AddressSchema.strict().meta({ id: 'AddressInput' });
export const PatchAddressBody = z
  .object({
    label: z.string().trim().max(40).optional(),
    line1: z.string().trim().min(1).max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    landmark: z.string().trim().max(120).optional(),
    locality: z.string().trim().max(60).nullable().optional(),
    formattedAddress: z.string().trim().max(300).nullable().optional(),
    city: z.string().trim().min(1).max(80).optional(),
    pincode: PincodeSchema.optional(),
    location: GeoPointSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'AddressPatch' });
export const AvatarUploadBody = z
  .object({
    contentType: z.string().min(3).max(100).describe('image/jpeg | image/png | image/webp'),
    sizeBytes: z.number().int().positive().describe('Exact file size (≤ 2 MB); signed into the URL'),
  })
  .strict()
  .meta({ id: 'AvatarUploadRequest' });
export const PresignedUploadResponse = z
  .object({
    key: z.string(),
    bucket: z.literal('public'),
    upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.string(), maxBytes: z.number() }),
  })
  .meta({ id: 'AvatarPresignedUpload' });
export const AddressListResponse = z.object({ items: z.array(AddressViewSchema) }).meta({ id: 'AddressList' });

// ---- admin ----
export const AdminUsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: RoleSchema.optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export const UserPageResponse = z.object({ items: z.array(UserViewSchema), nextCursor: z.string().nullable() }).meta({ id: 'UserPage' });
export const BlockBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).meta({ id: 'BlockUser' });
export const CreateAdminBody = z
  .object({
    email: z.email().max(254).transform((e) => e.toLowerCase()),
    name: z.string().trim().min(1).max(80),
    adminRoles: z.array(AdminRoleSchema).min(1),
  })
  .strict()
  .meta({ id: 'CreateAdmin' });
export const CreateAdminResponse = z
  .object({ user: UserViewSchema, oneTimePassword: z.string().describe('Shown once; admin must enrol TOTP on first login') })
  .meta({ id: 'CreatedAdmin' });

export const AuditLogsQuery = z.object({
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(128).optional(),
  actorId: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
  service: z.string().max(32).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export const AuditLogViewSchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    actorId: z.string(),
    actorRole: z.string(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    summary: z.string(),
    ip: z.string().nullable(),
    correlationId: z.string(),
    service: z.string(),
    occurredAt: z.string(),
  })
  .meta({ id: 'AuditLog' });
export const AuditLogPageResponse = z
  .object({ items: z.array(AuditLogViewSchema), nextCursor: z.string().nullable() })
  .meta({ id: 'AuditLogPage' });

// ---- internal ----
export const GrantRoleBody = z.object({ role: z.enum(['RESTAURANT_OWNER', 'DELIVERY_PARTNER']) }).meta({ id: 'GrantRole' });
export const GrantRoleResponse = z.object({ userId: z.string(), roles: z.array(RoleSchema) }).meta({ id: 'GrantRoleResult' });

export const JwksResponse = z
  .object({ keys: z.array(z.object({ kty: z.string(), crv: z.string(), x: z.string(), kid: z.string(), alg: z.string(), use: z.string() })) })
  .meta({ id: 'Jwks' });

export { ObjectIdSchema };
