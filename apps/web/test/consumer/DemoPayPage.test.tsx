import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DemoPayPage from '../../src/features/consumer/DemoPayPage';
import { __resetApiForTests } from '../../src/lib/api';
import { renderWithProviders } from '../utils';
import { errorBody, mockApi } from './fetchMock';

/** payments routes/demo-pay.ts */
const view = { paymentIntentId: 'pi1', purpose: 'CHECKOUT', referenceId: 'ck1', amountPaise: 81240, currency: 'INR', status: 'CREATED', providerOrderId: 'order_mock_1', isDemo: true };

describe('DemoPayPage', () => {
  beforeEach(() => __resetApiForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('is clearly labelled and "Simulate success" completes then returns to the status page', async () => {
    const m = mockApi({ 'GET /demo-pay/pi1': view, 'POST /demo-pay/pi1/complete': { paymentIntentId: 'pi1', status: 'CAPTURED', simulated: true, webhooks: [] } });
    const { router } = renderWithProviders(<DemoPayPage />, { route: '/demo-pay/pi1', path: '/demo-pay/:intentId' });
    expect(await screen.findByText('DEMO PAYMENT — no real money')).toBeInTheDocument();
    expect(screen.getByText('₹812.40')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /simulate success/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/checkout/status/ck1'));
    expect(m.callsTo('POST', '/demo-pay/pi1/complete')[0]!.body).toEqual({ outcome: 'success' });
  });

  it('"Simulate failure" posts outcome failure and honours a safe ?return=', async () => {
    const m = mockApi({ 'GET /demo-pay/pi1': view, 'POST /demo-pay/pi1/complete': { paymentIntentId: 'pi1', status: 'FAILED', simulated: true, webhooks: [] } });
    const { router } = renderWithProviders(<DemoPayPage />, { route: '/demo-pay/pi1?return=%2Fmembership%3Fpayment%3Dpi1', path: '/demo-pay/:intentId' });
    await userEvent.click(await screen.findByRole('button', { name: /simulate failure/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/membership'));
    expect(m.callsTo('POST', '/demo-pay/pi1/complete')[0]!.body).toEqual({ outcome: 'failure' });
  });

  it('demo payments disabled (404) explains instead of offering buttons', async () => {
    mockApi({ 'GET /demo-pay/pi1': [404, errorBody('NOT_FOUND', 'Not found')] });
    renderWithProviders(<DemoPayPage />, { route: '/demo-pay/pi1', path: '/demo-pay/:intentId' });
    expect(await screen.findByRole('heading', { name: /demo payment not available/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /simulate/i })).not.toBeInTheDocument();
  });
});
