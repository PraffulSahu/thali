/**
 * `support_tickets` (OCC) — LLD §3.3. Customer tickets (optionally about one of their orders) with a
 * message thread between the customer and support admins.
 */
import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { enumValues, TicketCategory, TicketStatus } from '@thali/contracts';
import { StatusHistorySchema, type StatusHistoryEntry } from './common.js';

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface TicketMessage {
  authorId: string;
  authorRole: 'CUSTOMER' | 'ADMIN';
  body: string;
  at: Date;
}

export interface SupportTicket {
  _id: Types.ObjectId;
  code: string;
  userId: string;
  childOrderId?: Types.ObjectId | null;
  checkoutGroupId?: Types.ObjectId | null;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  assigneeId?: string | null;
  priority: TicketPriority;
  messages: TicketMessage[];
  statusHistory: StatusHistoryEntry<TicketStatus>[];
  createdAt: Date;
  updatedAt: Date;
}
export type SupportTicketDoc = HydratedDocument<SupportTicket>;

const TicketMessageSchema = new Schema<TicketMessage>(
  {
    authorId: { type: String, required: true },
    authorRole: { type: String, enum: ['CUSTOMER', 'ADMIN'], required: true },
    body: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

export const SupportTicketSchema = new Schema<SupportTicket>(
  {
    code: { type: String, required: true },
    userId: { type: String, required: true },
    childOrderId: { type: Schema.Types.ObjectId, default: null },
    checkoutGroupId: { type: Schema.Types.ObjectId, default: null },
    subject: { type: String, required: true },
    category: { type: String, enum: enumValues(TicketCategory), required: true },
    status: { type: String, enum: enumValues(TicketStatus), required: true, default: 'OPEN' },
    assigneeId: { type: String, default: null },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'NORMAL' },
    messages: { type: [TicketMessageSchema], default: [] },
    statusHistory: { type: [StatusHistorySchema], default: [] },
  },
  { collection: 'support_tickets', timestamps: true, optimisticConcurrency: true },
);
SupportTicketSchema.index({ code: 1 }, { unique: true });
SupportTicketSchema.index({ status: 1, createdAt: -1 });
SupportTicketSchema.index({ userId: 1, createdAt: -1 });

export const supportTicketModel = (conn: Connection): Model<SupportTicket> =>
  (conn.models.SupportTicket as Model<SupportTicket> | undefined) ?? conn.model<SupportTicket>('SupportTicket', SupportTicketSchema);
