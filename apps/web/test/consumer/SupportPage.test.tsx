import '../setup';
import './slow';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportPage from '../../src/features/consumer/SupportPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';

const CK = 'cccccccccccccccccccccccc';
const CH = 'dddddddddddddddddddddddd';
/** `TicketView` (orders order-schemas.ts). */
const ticket = {
  id: 'eeeeeeeeeeeeeeeeeeeeeeee',
  code: 'TK-7K3M9QXA',
  userId: 'u1',
  childOrderId: CH,
  checkoutGroupId: CK,
  subject: 'Missing item',
  category: 'ORDER_ISSUE',
  status: 'OPEN',
  priority: 'NORMAL',
  assigneeId: null,
  messages: [{ authorId: 'u1', authorRole: 'CUSTOMER', body: 'The raita was missing', at: '2026-10-10T09:00:00.000Z' }],
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
};

describe('SupportPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('creates a ticket with CreateTicketBody {subject, category, body, checkoutGroupId, childOrderId}', async () => {
    const m = mockApi({ 'GET /support/tickets': { items: [], nextCursor: null }, 'POST /support/tickets': [201, ticket] });
    const { router } = renderWithProviders(<SupportPage />, { route: `/support?checkoutId=${CK}&childOrderId=${CH}`, path: '/support', auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.type(await screen.findByRole('textbox', { name: /subject/i }), 'Missing item');
    await userEvent.type(screen.getByRole('textbox', { name: /what happened/i }), 'The raita was missing');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(m.callsTo('POST', '/support/tickets')).toHaveLength(1));
    expect(m.callsTo('POST', '/support/tickets')[0]!.body).toEqual({
      subject: 'Missing item',
      category: 'ORDER_ISSUE',
      body: 'The raita was missing',
      checkoutGroupId: CK,
      childOrderId: CH,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/support/${ticket.id}`));
  });

  it('lists my tickets with their status', async () => {
    mockApi({ 'GET /support/tickets': { items: [ticket], nextCursor: null } });
    renderWithProviders(<SupportPage />, { route: '/support', path: '/support', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByText('Missing item')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });
});
