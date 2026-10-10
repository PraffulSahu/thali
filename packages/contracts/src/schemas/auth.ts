import { z } from 'zod';
import { AdminRole, Role, enumValues } from '../enums.js';
import { PhoneSchema } from './common.js';

export const OtpRequestSchema = z.object({ phone: PhoneSchema });
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpCodeSchema = z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code');

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: OtpCodeSchema,
  guestCartToken: z.string().min(1).max(256).optional(),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const AdminLoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type AdminLogin = z.infer<typeof AdminLoginSchema>;

export const AdminMfaSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code'),
});
export type AdminMfa = z.infer<typeof AdminMfaSchema>;

export const RoleSchema = z.enum(enumValues(Role));
export const AdminRoleSchema = z.enum(enumValues(AdminRole));

/** `req.auth` for user tokens (LLD 1.5). */
export const AuthContextSchema = z.object({
  userId: z.string(),
  roles: z.array(RoleSchema),
  sessionId: z.string(),
  amr: z.array(z.string()),
  adminRoles: z.array(AdminRoleSchema).optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;
