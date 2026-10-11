import '../setup';
import './slow';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MembershipPage from '../../src/features/consumer/MembershipPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';

const benefits = { freeDeliveryMinOrderPaise: 19900, freeDeliveriesPerPeriod: 10, extraDiscountBps: 500, extraDiscountCapPaise: 5000 };
const plan = { id: 'pppppppppppppppppppppppp', name: 'Thali Plus', pricePaise: 14900, durationDays: 30, benefits, terms: 'Prepaid. No auto-renewal.', active: true };
/** `MembershipView` (marketplace routes/memberships.ts). */
const membership = (over: Record<string, unknown> = {}) => ({
  id: 'mmmmmmmmmmmmmmmmmmmmmmmm',
  planId: plan.id,
  plan: { name: plan.name, pricePaise: plan.pricePaise, durationDays: 30, benefits, terms: plan.terms },
  status: 'ACTIVE',
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-10-31T00:00:00.000Z',
  paymentIntentId: 'pi9',
  freeDeliveriesUsed: 3,
  freeDeliveriesRemaining: 7,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('MembershipPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('shows the current membership from {current, history} and disables Buy with the reason', async () => {
    mockApi({ 'GET /memberships/plans': { items: [plan] }, 'GET /memberships/me': { current: membership(), history: [membership()] } });
    renderWithProviders(<MembershipPage />, { route: '/membership', path: '/membership', auth: makeAuth({ roles: ['CONSUMER'] }) });
    const mine = await screen.findByRole('region', { name: /your membership/i });
    await waitFor(() => expect(mine).toHaveTextContent('Thali Plus'));
    expect(mine).toHaveTextContent('7 of 10 free deliveries left this plan period');
    expect(await screen.findByRole('button', { name: /your active plan/i })).toBeDisabled();
    expect(screen.getByText(/you already have an active membership until/i)).toBeInTheDocument();
  });

  it('buys through POST /memberships/purchase (Idempotency-Key) and opens the demo payment', async () => {
    const m = mockApi({
      'GET /memberships/plans': { items: [plan] },
      'GET /memberships/me': { current: null, history: [] },
      'POST /memberships/purchase': [201, {
        membership: membership({ status: 'PENDING_PAYMENT', startsAt: null, endsAt: null, freeDeliveriesRemaining: 0 }),
        payment: { paymentIntentId: 'pi9', provider: 'mock', providerOrderId: 'order_m9', keyId: null, amountPaise: 14900, currency: 'INR', status: 'CREATED', demoPayUrl: 'http://x/demo-pay/pi9' },
      }],
    });
    const { router } = renderWithProviders(<MembershipPage />, { route: '/membership', path: '/membership', auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: /buy for ₹149\.00/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/demo-pay/pi9'));
    const call = m.callsTo('POST', '/memberships/purchase')[0]!;
    expect(call.body).toEqual({ planId: plan.id });
    expect(call.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});
