/** Restaurant, partner and platform balances from the ledger. Payouts are requested from the available amount. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Price } from '../../components/ui/Price';
import { Select } from '../../components/ui/Select';
import { listBalances, qk, type Balance } from './api';
import { Mono, useAdminRoles } from './shared';
import type { PayoutPrefill } from './PayoutsPanel';

export default function BalancesPanel({ onRequestPayout }: { onRequestPayout: (p: PayoutPrefill) => void }) {
  const { canFinance } = useAdminRoles();
  const [accountType, setAccountType] = useState('RESTAURANT');
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: [...qk.balances(accountType), pages.cursor],
    queryFn: () => listBalances(accountType, pages.cursor),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Balance>[] = [
    { key: 'account', header: 'Account', cell: (b) => <Mono>{b.accountId}</Mono>, primary: true },
    { key: 'balance', header: 'Balance', cell: (b) => <Price paise={b.balancePaise} />, align: 'right' },
    { key: 'available', header: `Available (after hold)`, cell: (b) => <Price paise={b.availablePaise} />, align: 'right' },
    { key: 'pending', header: 'Pending payout', cell: (b) => <Price paise={b.pendingPayoutPaise} />, align: 'right', hideOnMobile: true },
    { key: 'paid', header: 'Paid out', cell: (b) => <Price paise={b.paidOutPaise} />, align: 'right', hideOnMobile: true },
  ];

  return (
    <div>
      <Field label="Account type" className="mb-4 w-full sm:w-56">
        <Select
          value={accountType}
          onChange={(e) => { setAccountType(e.target.value); pages.reset(); }}
          options={[{ value: 'RESTAURANT', label: 'Restaurants' }, { value: 'PARTNER', label: 'Delivery partners' }, { value: 'PLATFORM', label: 'Platform' }]}
        />
      </Field>
      <DataTable
        caption="Balances"
        columns={columns}
        rows={query.data?.items}
        getRowId={(b) => b.accountId}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'wallet', title: 'No ledger activity yet', description: 'Balances appear after delivered orders are settled into the ledger.' }}
        rowActions={(b) =>
          canFinance && accountType !== 'PLATFORM' && b.availablePaise > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => onRequestPayout({ accountType: accountType as 'RESTAURANT' | 'PARTNER', accountId: b.accountId, amountPaise: b.availablePaise })}>
              Request payout
            </Button>
          ) : null
        }
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
      <p className="mt-3 text-sm text-slate-600">Available excludes earnings still inside the hold period and payouts already requested.</p>
    </div>
  );
}
