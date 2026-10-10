/**
 * Payouts are recorded after a manual bank transfer (ADR-010): create a request (reduces the available
 * balance), transfer the money outside the app, then confirm here with the bank's UTR. There is no
 * automated disbursement, and a payout cannot be marked paid without a valid UTR.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input, Textarea } from '../../components/ui/Input';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Price } from '../../components/ui/Price';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { formatDateTime } from '../../lib/format';
import { confirmPayout, createPayout, failPayout, listPayouts, paiseToRupees, qk, rupeesToPaise, UTR_PATTERN, type Payout } from './api';
import { Mono, useAdminMutation, useAdminRoles } from './shared';

export interface PayoutPrefill {
  accountType: 'RESTAURANT' | 'PARTNER';
  accountId: string;
  amountPaise: number;
}

function ConfirmUtrDialog({ payout, onClose }: { payout: Payout | null; onClose: () => void }) {
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const confirm = useAdminMutation((v: { id: string; utr: string }) => confirmPayout(v.id, v.utr), {
    success: 'Payout recorded as paid',
    invalidate: [['admin', 'finance']],
  });
  useEffect(() => {
    setUtr('');
    setError(null);
  }, [payout?.id]);

  const value = utr.trim();
  const valid = UTR_PATTERN.test(value);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!payout || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirm.mutateAsync({ id: payout.id, utr: value });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={payout !== null}
      onClose={onClose}
      dismissible={!busy}
      title="Record bank payment"
      description={payout ? `Confirm that ${payout.accountType.toLowerCase()} ${payout.accountId} was paid. This posts the ledger entry and cannot be undone.` : undefined}
      size="sm"
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid} loading={busy}>
            Record payment
          </Button>
        </FormActions>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {payout ? (
          <p className="text-[0.9375rem]">
            Amount transferred: <Price paise={payout.amountPaise} size="lg" />
          </p>
        ) : null}
        <Field
          label="UTR (bank reference)"
          required
          hint="Copy it from the bank transfer receipt"
          error={value !== '' && !valid ? 'Enter the bank’s UTR: 6–32 letters or digits, no spaces.' : undefined}
        >
          <Input value={utr} onChange={(e) => setUtr(e.target.value)} autoComplete="off" spellCheck={false} maxLength={40} className="font-mono" />
        </Field>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}

function CreatePayoutDialog({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: PayoutPrefill | null }) {
  const idem = useIdempotencyKey();
  const [accountType, setAccountType] = useState<'RESTAURANT' | 'PARTNER'>('RESTAURANT');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = useAdminMutation((v: { body: Parameters<typeof createPayout>[0]; key: string }) => createPayout(v.body, v.key), {
    success: 'Payout requested',
    invalidate: [['admin', 'finance']],
  });

  useEffect(() => {
    if (!open) return;
    setAccountType(prefill?.accountType ?? 'RESTAURANT');
    setAccountId(prefill?.accountId ?? '');
    setAmount(prefill ? paiseToRupees(prefill.amountPaise) : '');
    setNotes('');
    setError(null);
  }, [open, prefill]);
  // A different payload is a different attempt: never reuse a key for changed content.
  const { renew } = idem;
  useEffect(() => renew(), [accountType, accountId, amount, notes, renew]);

  const paise = rupeesToPaise(amount);
  const amountError = amount !== '' && (paise === null || paise <= 0) ? 'Enter a positive amount in rupees, like 1500 or 1500.50.' : undefined;
  const valid = accountId.trim().length > 0 && paise !== null && paise > 0;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || paise === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create.mutateAsync({ body: { accountType, accountId: accountId.trim(), amountPaise: paise, ...(notes.trim() ? { notes: notes.trim() } : {}) }, key: idem.key });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Request a payout"
      description="The amount must not exceed the account's available balance (after the hold period and pending payouts)."
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid} loading={busy}>
            Request payout
          </Button>
        </FormActions>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Account type" required>
          <Select value={accountType} onChange={(e) => setAccountType(e.target.value as 'RESTAURANT' | 'PARTNER')} options={[{ value: 'RESTAURANT', label: 'Restaurant' }, { value: 'PARTNER', label: 'Delivery partner' }]} />
        </Field>
        <Field label="Account id" required hint="The restaurant or partner id shown in Balances">
          <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Amount" required error={amountError}>
          <Input inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Notes" optional>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
        </Field>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}

export default function PayoutsPanel({ prefill, onPrefillUsed }: { prefill?: PayoutPrefill | null; onPrefillUsed?: () => void }) {
  const { canFinance } = useAdminRoles();
  const [status, setStatus] = useState('');
  const [confirming, setConfirming] = useState<Payout | null>(null);
  const [failing, setFailing] = useState<Payout | null>(null);
  const [creating, setCreating] = useState(false);
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: qk.payouts({ status, cursor: pages.cursor }),
    queryFn: () => listPayouts({ status: status || undefined, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const fail = useAdminMutation((v: { id: string; reason: string }) => failPayout(v.id, v.reason), { success: 'Payout marked as failed', invalidate: [['admin', 'finance']] });

  useEffect(() => {
    if (prefill) setCreating(true);
  }, [prefill]);

  const open = (p: Payout) => p.status === 'REQUESTED' || p.status === 'PROCESSING';
  const columns: Column<Payout>[] = [
    { key: 'account', header: 'Account', cell: (p) => <span>{p.accountType === 'PARTNER' ? 'Partner' : 'Restaurant'} <Mono>{p.accountId}</Mono></span>, primary: true },
    { key: 'amount', header: 'Amount', cell: (p) => <Price paise={p.amountPaise} />, align: 'right' },
    { key: 'status', header: 'Status', cell: (p) => <StatusPill kind="payout" status={p.status} /> },
    { key: 'utr', header: 'UTR', cell: (p) => (p.utr ? <Mono>{p.utr}</Mono> : p.failureReason ? `Failed: ${p.failureReason}` : '-') },
    { key: 'created', header: 'Requested', cell: (p) => formatDateTime(p.createdAt), hideOnMobile: true },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Field label="Status" className="w-full sm:w-56">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); pages.reset(); }} placeholder="All statuses" options={['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
        </Field>
        {canFinance ? <Button icon="plus" onClick={() => setCreating(true)}>Request payout</Button> : null}
      </div>
      <DataTable
        caption="Payouts"
        columns={columns}
        rows={query.data?.items}
        getRowId={(p) => p.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'wallet', title: 'No payouts yet', description: 'Request a payout from an account with an available balance.' }}
        rowActions={(p) =>
          open(p) && canFinance ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setConfirming(p)}>Confirm payout</Button>
              <Button size="sm" variant="ghost" onClick={() => setFailing(p)}>Mark failed</Button>
            </div>
          ) : null
        }
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
      <ConfirmUtrDialog payout={confirming} onClose={() => setConfirming(null)} />
      <ConfirmDialog
        open={failing !== null}
        onClose={() => setFailing(null)}
        title="Mark this payout as failed?"
        description="The reserved amount returns to the account's available balance."
        confirmLabel="Mark failed"
        tone="danger"
        reason={{ label: 'Reason', minLength: 3, options: ['Bank rejected the transfer', 'Wrong account details', 'Cancelled by finance'] }}
        onConfirm={(reason) => fail.mutateAsync({ id: failing!.id, reason: reason ?? '' })}
      />
      <CreatePayoutDialog open={creating} prefill={prefill} onClose={() => { setCreating(false); onPrefillUsed?.(); }} />
    </div>
  );
}

