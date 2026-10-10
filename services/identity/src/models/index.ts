import type { Connection } from 'mongoose';
import { AdminCredentialModel } from './admin-credential.js';
import { AuditLogModel } from './audit-log.js';
import { OtpChallengeModel } from './otp-challenge.js';
import { SessionModel } from './session.js';
import { SigningKeyModel } from './signing-key.js';
import { UserModel } from './user.js';

export function models(conn: Connection) {
  return {
    User: UserModel(conn),
    OtpChallenge: OtpChallengeModel(conn),
    Session: SessionModel(conn),
    AdminCredential: AdminCredentialModel(conn),
    AuditLog: AuditLogModel(conn),
    SigningKey: SigningKeyModel(conn),
  };
}
export type Models = ReturnType<typeof models>;
