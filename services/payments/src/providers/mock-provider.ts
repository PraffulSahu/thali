/**
 * Demo payment provider (ADR-011). Never available in production (loadConfig guard refuses
 * PAYMENT_PROVIDER=mock). Provider-side state (payments/refunds the "gateway" knows about) is kept in
 * the payments DB (`mock_provider_payments`, `mock_provider_refunds`) so reconciliation works in demo.
 * Webhooks are Razorpay-shaped and HMAC-signed with MOCK_WEBHOOK_SECRET.
 */
import { randomBytes } from 'node:crypto';
import { Schema, type Connection, type Model } from 'mongoose';
import {
  parseRazorpayWebhook,
  signHexHmac,
  verifyHexHmac,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from './payment-provider.js';

interface MockPaymentDoc {
  _id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: ProviderPayment['status'];
  errorDescription?: string;
  createdAt: Date;
}
interface MockRefundDoc {
  _id: string;
  paymentId: string;
  amountPaise: number;
  status: ProviderRefund['status'];
  notes: Record<string, string>;
  idempotencyKey: string;
}

const paymentSchema = new Schema<MockPaymentDoc>(
  {
    _id: String,
    orderId: { type: String, index: true },
    amountPaise: Number,
    currency: String,
    status: String,
    errorDescription: String,
    createdAt: Date,
  },
  { collection: 'mock_provider_payments', versionKey: false },
);
const refundSchema = new Schema<MockRefundDoc>(
  {
    _id: String,
    paymentId: String,
    amountPaise: Number,
    status: String,
    notes: { type: Schema.Types.Mixed, default: {} },
    idempotencyKey: { type: String, unique: true },
  },
  { collection: 'mock_provider_refunds', versionKey: false, minimize: false },
);

export interface MockProvider extends PaymentProvider {
  readonly name: 'mock';
  /** Record a payment attempt on the mock gateway (demo pay page). */
  recordPayment(p: { orderId: string; amountPaise: number; status: 'captured' | 'failed'; errorDescription?: string }): Promise<ProviderPayment>;
  /** Sign a raw webhook body the way the provider would. */
  signWebhook(rawBody: string | Buffer): string;
}

export function createMockProvider(opts: { conn: Connection; webhookSecret: string }): MockProvider {
  const Payments: Model<MockPaymentDoc> =
    (opts.conn.models.MockProviderPayment as Model<MockPaymentDoc> | undefined) ?? opts.conn.model<MockPaymentDoc>('MockProviderPayment', paymentSchema);
  const Refunds: Model<MockRefundDoc> =
    (opts.conn.models.MockProviderRefund as Model<MockRefundDoc> | undefined) ?? opts.conn.model<MockRefundDoc>('MockProviderRefund', refundSchema);
  const toPayment = (d: MockPaymentDoc): ProviderPayment => ({
    id: d._id,
    orderId: d.orderId,
    amountPaise: d.amountPaise,
    currency: d.currency,
    status: d.status,
    captured: d.status === 'captured' || d.status === 'refunded',
    createdAt: d.createdAt,
    ...(d.errorDescription ? { errorDescription: d.errorDescription } : {}),
  });
  const toRefund = (d: MockRefundDoc): ProviderRefund => ({
    id: d._id,
    paymentId: d.paymentId,
    amountPaise: d.amountPaise,
    status: d.status,
    notes: d.notes ?? {},
    receipt: d.idempotencyKey,
  });

  return {
    name: 'mock',
    keyId: null,
    async createOrder() {
      return { providerOrderId: `mock_order_${randomBytes(8).toString('hex')}` };
    },
    async fetchOrderPayments(orderId) {
      const docs = await Payments.find({ orderId }).sort({ createdAt: 1 }).lean();
      return docs.map(toPayment);
    },
    async capture(paymentId, amountPaise) {
      const d = await Payments.findOneAndUpdate({ _id: paymentId, status: 'authorized' }, { $set: { status: 'captured' } }, { new: true }).lean();
      const doc = d ?? (await Payments.findById(paymentId).lean());
      if (!doc) throw new Error(`mock payment ${paymentId} not found`);
      return { ...toPayment(doc), amountPaise };
    },
    async refund(input) {
      // Mock refunds settle instantly (still REQUESTED → PROCESSING → SUCCEEDED on our side).
      const existing = await Refunds.findOne({ idempotencyKey: input.idempotencyKey }).lean();
      if (existing) return { providerRefundId: existing._id, status: existing.status };
      const doc = await Refunds.create({
        _id: `mock_rfnd_${randomBytes(8).toString('hex')}`,
        paymentId: input.paymentId,
        amountPaise: input.amountPaise,
        status: 'processed',
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      });
      return { providerRefundId: doc._id, status: 'processed' };
    },
    async fetchRefund(id) {
      const d = await Refunds.findById(id).lean();
      if (!d) throw new Error(`mock refund ${id} not found`);
      return toRefund(d);
    },
    verifyWebhook(rawBody, signature) {
      return verifyHexHmac(opts.webhookSecret, rawBody, signature);
    },
    verifyPaymentSignature(orderId, paymentId, signature) {
      return verifyHexHmac(opts.webhookSecret, `${orderId}|${paymentId}`, signature);
    },
    parseWebhook(json) {
      return parseRazorpayWebhook(json);
    },
    async recordPayment(p) {
      const doc = await Payments.create({
        _id: `pay_mock_${randomBytes(8).toString('hex')}`,
        orderId: p.orderId,
        amountPaise: p.amountPaise,
        currency: 'INR',
        status: p.status,
        ...(p.errorDescription ? { errorDescription: p.errorDescription } : {}),
        createdAt: new Date(),
      });
      return toPayment(doc.toObject());
    },
    signWebhook(rawBody) {
      return signHexHmac(opts.webhookSecret, rawBody);
    },
  };
}
