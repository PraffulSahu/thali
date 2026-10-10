/** Fakes for the orders + payments internal clients (Task 9). No imports from helpers.ts (avoids cycles). */
import { randomBytes } from 'node:crypto';
import { DomainError } from '@thali/contracts';
import type { ChildOrderInfo, CheckoutStatusInfo, OrderStats, OrdersClient } from '../src/clients/orders.js';
import type { CreateIntentRequest, PaymentIntentView, PaymentsClient } from '../src/clients/payments.js';

export interface FakeOrders extends OrdersClient {
  checkouts: Map<string, CheckoutStatusInfo>;
  children: Map<string, ChildOrderInfo>;
  stats: OrderStats | null;
  statusCalls: string[];
  childCalls: string[];
  statsCalls: { restaurantId: string; from: string; to: string }[];
  /** When true every call throws an upstream error. */
  fail: boolean;
}

const upstream = () => new DomainError('UPSTREAM_UNAVAILABLE', 'orders down');

export function fakeOrders(): FakeOrders {
  const f: FakeOrders = {
    checkouts: new Map(),
    children: new Map(),
    stats: null,
    statusCalls: [],
    childCalls: [],
    statsCalls: [],
    fail: false,
    async getCheckoutStatus(id) {
      f.statusCalls.push(id);
      if (f.fail) throw upstream();
      return f.checkouts.get(id) ?? null;
    },
    async getChildOrder(id) {
      f.childCalls.push(id);
      if (f.fail) throw upstream();
      return f.children.get(id) ?? null;
    },
    async getStats(q) {
      f.statsCalls.push(q);
      if (f.fail) throw upstream();
      return (
        f.stats ?? {
          restaurantId: q.restaurantId,
          from: q.from,
          to: q.to,
          ordersTotal: 0,
          byStatus: {},
          acceptanceRate: null,
          avgAcceptSeconds: null,
          grossPaise: 0,
          netRevenuePaise: 0,
        }
      );
    },
  };
  return f;
}

export interface FakePayments extends PaymentsClient {
  calls: CreateIntentRequest[];
  intents: Map<string, PaymentIntentView>;
  fail: boolean;
}

export function fakePayments(): FakePayments {
  const f: FakePayments = {
    calls: [],
    intents: new Map(),
    fail: false,
    async createIntent(req) {
      f.calls.push(req);
      if (f.fail) throw new DomainError('UPSTREAM_UNAVAILABLE', 'payments down');
      const key = `${req.purpose}:${req.referenceId}`;
      let intent = f.intents.get(key);
      if (!intent) {
        intent = {
          paymentIntentId: randomBytes(12).toString('hex'),
          provider: 'mock',
          providerOrderId: `order_${randomBytes(6).toString('hex')}`,
          keyId: null,
          amountPaise: req.amountPaise,
          currency: 'INR',
          status: 'CREATED',
          demoPayUrl: 'http://web.test/demo-pay/x',
        };
        f.intents.set(key, intent);
      }
      return intent;
    },
  };
  return f;
}
