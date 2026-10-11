/** Step 6: settlement bank account. Stored encrypted by the server; only the last 4 digits come back. */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Field, Input } from '../../../components/ui';
import { fieldErrors } from '../../../lib/errors';
import { restaurantApi } from '../api';
import { StepFrame, type StepProps } from './StepFrame';

export interface SettlementValues {
  accountHolder: string;
  accountNumber: string;
  confirmNumber: string;
  ifsc: string;
}

export function validateSettlement(v: SettlementValues): Record<string, string> {
  const e: Record<string, string> = {};
  if (v.accountHolder.trim().length < 2) e.accountHolder = 'Enter the account holder name.';
  if (!/^\d{9,18}$/.test(v.accountNumber)) e.accountNumber = 'Account number must be 9 to 18 digits.';
  if (v.confirmNumber !== v.accountNumber) e.confirmNumber = "The account numbers don't match.";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) e.ifsc = 'Enter a valid IFSC, e.g. HDFC0001234.';
  return e;
}

export function SettlementStep({ restaurant, onSaved, next, back }: StepProps) {
  const existing = restaurant?.settlement ?? null;
  const [editing, setEditing] = useState(!existing);
  const [v, setV] = useState<SettlementValues>({ accountHolder: existing?.accountHolder ?? '', accountNumber: '', confirmNumber: '', ifsc: existing?.ifsc ?? '' });
  const [show, setShow] = useState(false);
  const errors = validateSettlement(v);
  const save = useMutation({
    mutationFn: () => restaurantApi.setSettlement(restaurant!.id, { accountHolder: v.accountHolder.trim(), accountNumber: v.accountNumber, ifsc: v.ifsc }),
    onSuccess: (s) => {
      onSaved({ ...restaurant!, settlement: s });
      next();
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string) => (show ? errors[k] : undefined) ?? server[k];
  const set = <K extends keyof SettlementValues>(k: K, val: string) => setV((p) => ({ ...p, [k]: val }));

  return (
    <StepFrame
      title="Settlement details"
      description="Payouts are sent to this bank account. The account number is stored encrypted and never shown in full again."
      submitting={save.isPending}
      submitLabel={editing ? 'Save and continue' : 'Keep these details and continue'}
      error={save.isError && Object.keys(server).length === 0 ? save.error : null}
      onBack={back}
      onSubmit={() => {
        if (!editing) return next();
        if (Object.keys(errors).length > 0) {
          setShow(true);
          return;
        }
        save.mutate();
      }}
    >
      {existing && !editing ? (
        <Card tone="muted" padding="sm" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-fg">{existing.accountHolder}</p>
            <p className="text-sm text-fg-3">Account ending {existing.last4} · IFSC {existing.ifsc}</p>
          </div>
          <button type="button" className="text-sm font-semibold text-acc-fg underline-offset-4 hover:underline" onClick={() => setEditing(true)}>
            Replace details
          </button>
        </Card>
      ) : (
        <>
          <Field label="Account holder name" required error={err('accountHolder')}>
            <Input value={v.accountHolder} onChange={(e) => set('accountHolder', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Account number" required error={err('accountNumber')}>
            <Input inputMode="numeric" autoComplete="off" value={v.accountNumber} onChange={(e) => set('accountNumber', e.target.value.replace(/\D/g, ''))} maxLength={18} />
          </Field>
          <Field label="Confirm account number" required error={err('confirmNumber')}>
            <Input inputMode="numeric" autoComplete="off" value={v.confirmNumber} onChange={(e) => set('confirmNumber', e.target.value.replace(/\D/g, ''))} maxLength={18} />
          </Field>
          <Field label="IFSC code" required error={err('ifsc')} hint="11 characters, e.g. HDFC0001234">
            <Input autoComplete="off" value={v.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={11} />
          </Field>
        </>
      )}
    </StepFrame>
  );
}
