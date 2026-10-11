import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { RoleSidebarShell } from '../../src/components/layout/RoleSidebarShell';
import { nav, routes, shell } from '../../src/features/admin/routes';
import { renderWithProviders } from '../utils';
import { adminAuth, healthReport, json, marketOverview, ordersOverview, routeFetch, tmsOverview } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('Admin shell (board 40 sidebar)', () => {
  it('has grouped nav with live badges, the ⌘K search card and the sub-role footer', async () => {
    routeFetch([
      ['/admin/orders/overview', () => json(ordersOverview)],
      ['/admin/delivery/overview', () => json(tmsOverview)],
      ['/admin/marketplace/overview', () => json(marketOverview)],
      ['/admin/health', () => json(healthReport)],
      ['/meta', () => json({ mode: 'demo', providers: {} })],
    ]);
    renderWithProviders(
      <RoleSidebarShell role="admin" nav={nav} {...shell}>
        <p>page</p>
      </RoleSidebarShell>,
      { route: '/admin', auth: adminAuth(['OPS']) },
    );
    const sidebar = screen.getAllByRole('navigation', { name: 'Admin' })[0]!;
    expect(within(sidebar).getByText('Marketplace')).toBeInTheDocument();
    expect(within(sidebar).getByText('Operations')).toBeInTheDocument();
    expect(within(sidebar).getByText('System')).toBeInTheDocument();
    expect(await within(sidebar).findByText('restaurants awaiting approval')).toBeInTheDocument();
    expect(within(sidebar).getByText('partners awaiting approval')).toBeInTheDocument();
    expect(within(sidebar).getByText('unassigned deliveries')).toBeInTheDocument();
    expect(within(sidebar).getByText('open tickets')).toBeInTheDocument();
    // delivery is down in the fixture → red health dot
    expect(await within(sidebar).findByText('a service is down')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /search orders, phones/i, hidden: true }).length).toBeGreaterThanOrEqual(2); // sidebar card + phone top-bar icon
    expect(screen.getAllByText('Ops admin · MFA on').length).toBeGreaterThan(0);
  });

  it('redirects the old admin login route to the unified sign-in', () => {
    expect(routes.find((r) => r.path === 'login/*')).toBeDefined();
    expect(routes.some((r) => r.path === 'login' && 'lazy' in r)).toBe(false);
  });
});
