/** `order_events` — append-only checkout/child timeline (LLD §3.3); admin timeline view (Task 12). */
import { Schema, type ClientSession, type Connection, type Model, type Types } from 'mongoose';

export interface OrderEvent {
  _id: Types.ObjectId;
  checkoutGroupId: Types.ObjectId;
  childOrderId?: Types.ObjectId | null;
  type: string;
  data: Record<string, unknown>;
  actor: string;
  actorId?: string | null;
  at: Date;
}

export const OrderEventSchema = new Schema<OrderEvent>(
  {
    checkoutGroupId: { type: Schema.Types.ObjectId, required: true },
    childOrderId: { type: Schema.Types.ObjectId, default: null },
    type: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    actor: { type: String, required: true },
    actorId: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { collection: 'order_events', versionKey: false, minimize: false },
);
OrderEventSchema.index({ checkoutGroupId: 1, at: 1 });

export const orderEventModel = (conn: Connection): Model<OrderEvent> =>
  (conn.models.OrderEvent as Model<OrderEvent> | undefined) ?? conn.model<OrderEvent>('OrderEvent', OrderEventSchema);

export interface TimelineEntry {
  checkoutGroupId: Types.ObjectId;
  childOrderId?: Types.ObjectId | null;
  type: string;
  data?: Record<string, unknown>;
  actor: string;
  actorId?: string | null;
  at?: Date;
}

/** Append timeline entries inside the caller's transaction. */
export async function appendOrderEvents(conn: Connection, session: ClientSession, entries: TimelineEntry[]): Promise<void> {
  if (!entries.length) return;
  const now = new Date();
  await orderEventModel(conn).insertMany(
    entries.map((e) => ({ ...e, data: e.data ?? {}, at: e.at ?? now })),
    { session },
  );
}
