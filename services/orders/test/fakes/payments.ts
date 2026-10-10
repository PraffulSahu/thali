/** In-memory PaymentsClient fake: intents idempotent per purpose+referenceId (binding shape). */
import { Types } from 'mongoose';
import { DomainError, type PaymentStatus } from '@thali/contracts';
import type { CreateIntentRequest, PaymentIntentView, PaymentsClient, ReconcileResult } from '../../src/clients/payments.js';

export class FakePayments implements PaymentsClient {
  intents = new Map<string, PaymentIntentView & { referenceId: string; purpose: string; capturedPaise: number }>();
  createCalls: CreateIntentRequest[] = [];
  reconcileCalls: string[] = [];
  /** Throw from createIntent (e.g. provider down). */
  down = false;
  /** Throw from reconcile. */
  reconcileDown = false;
  /** Status reconcile reports, per intent id (default: the intent's current status). */
  reconcileStatus = new Map<string, { status: PaymentStatus; capturedPaise: number }>();

  async createIntent(req: CreateIntentRequest): Promise<PaymentIntentView> {
    this.createCalls.push(req);
    if (this.down) throw new DomainError('UPSTREAM_UNAVAILABLE', 'payments is unreachable', 502);
    const existing = [...this.intents.values()].find((i) => i.purpose === req.purpose && i.referenceId === req.referenceId);
    if (existing) return this.view(existing);
    const id = new Types.ObjectId().toHexString();
    const intent = {
      paymentIntentId: id,
      provider: 'mock' as const,
      providerOrderId: `order_mock_${id.slice(-8)}`,
      keyId: null,
      amountPaise: req.amountPaise,
      currency: 'INR' as const,
      status: 'CREATED' as PaymentStatus,
      demoPayUrl: `http://localhost:5173/demo-pay/${id}`,
      referenceId: req.referenceId,
      purpose: req.purpose,
      capturedPaise: 0,
    };
    this.intents.set(id, intent);
    return this.view(intent);
  }

  async reconcile(intentId: string): Promise<ReconcileResult> {
    this.reconcileCalls.push(intentId);
    if (this.reconcileDown) throw new DomainError('UPSTREAM_UNAVAILABLE', 'payments is unreachable', 502);
    const i = this.intents.get(intentId);
    if (!i) throw new DomainError('NOT_FOUND', 'intent not found', 404);
    const forced = this.reconcileStatus.get(intentId);
    return { paymentIntentId: intentId, status: forced?.status ?? i.status, capturedPaise: forced?.capturedPaise ?? i.capturedPaise };
  }

  async getByReference(purpose: 'CHECKOUT' | 'MEMBERSHIP', refId: string): Promise<PaymentIntentView | null> {
    const i = [...this.intents.values()].find((x) => x.purpose === purpose && x.referenceId === refId);
    return i ? this.view(i) : null;
  }

  intentFor(referenceId: string) {
    return [...this.intents.values()].find((i) => i.referenceId === referenceId);
  }

  private view(i: PaymentIntentView): PaymentIntentView {
    return {
      paymentIntentId: i.paymentIntentId,
      provider: i.provider,
      providerOrderId: i.providerOrderId,
      keyId: i.keyId,
      amountPaise: i.amountPaise,
      currency: i.currency,
      status: i.status,
      demoPayUrl: i.demoPayUrl,
    };
  }
}
