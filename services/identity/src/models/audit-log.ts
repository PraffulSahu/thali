/** `audit_logs` (LLD §3.1): central audit trail fed by `audit.recorded` from every service stream. */
import { Schema, type Connection, type Types } from 'mongoose';
import { defineModel } from './_model.js';

export interface AuditLogDoc {
  _id: Types.ObjectId;
  eventId: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  ip?: string | null;
  correlationId: string;
  service: string;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema = new Schema<AuditLogDoc>(
  {
    eventId: { type: String, required: true },
    actorId: { type: String, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    summary: { type: String, required: true },
    ip: { type: String, default: null },
    correlationId: { type: String, required: true },
    service: { type: String, required: true },
    occurredAt: { type: Date, required: true },
  },
  { collection: 'audit_logs', timestamps: true },
);
AuditLogSchema.index({ eventId: 1 }, { unique: true });
AuditLogSchema.index({ occurredAt: -1, _id: -1 });
AuditLogSchema.index({ targetType: 1, targetId: 1, occurredAt: -1 });
AuditLogSchema.index({ actorId: 1, occurredAt: -1 });

export const AuditLogModel = (conn: Connection) => defineModel<AuditLogDoc>(conn, 'AuditLog', AuditLogSchema);
