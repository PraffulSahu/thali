/** `/admin/finance`: refunds, balances and payouts. Needs the FINANCE (or SUPER_ADMIN) admin role. */
import { useState } from 'react';
import { PageHeader } from '../../components/ui/PageHeader';
import { Tabs } from '../../components/ui/Tabs';
import BalancesPanel from './BalancesPanel';
import PayoutsPanel, { type PayoutPrefill } from './PayoutsPanel';
import RefundsPanel from './RefundsPanel';
import { useAdminRoles } from './shared';

export default function FinancePage() {
  const { canFinance } = useAdminRoles();
  const [tab, setTab] = useState('refunds');
  const [prefill, setPrefill] = useState<PayoutPrefill | null>(null);

  return (
    <>
      <PageHeader title="Finance" description="Review refunds, see what restaurants and partners are owed, and record manual payouts." />
      {!canFinance ? (
        <p role="note" className="mb-4 rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">
          Finance data needs the Finance admin role. You may see access errors below.
        </p>
      ) : null}
      <Tabs
        label="Finance sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'refunds', label: 'Refunds', content: <RefundsPanel /> },
          { id: 'balances', label: 'Balances', content: <BalancesPanel onRequestPayout={(p) => { setPrefill(p); setTab('payouts'); }} /> },
          { id: 'payouts', label: 'Payouts', content: <PayoutsPanel prefill={prefill} onPrefillUsed={() => setPrefill(null)} /> },
        ]}
      />
    </>
  );
}
