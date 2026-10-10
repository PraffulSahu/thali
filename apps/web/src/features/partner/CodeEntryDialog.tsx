/**
 * 4-digit handover code entry (pickup code from the restaurant, delivery code from the customer).
 * The server counts every guess: a wrong code answers 400 DELIVERY_CODE_INVALID with `details.attemptsRemaining`;
 * at the limit it answers 423 DELIVERY_CODE_LOCKED and the job stays locked until support/admin steps in.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input } from '../../components/ui/Input';
import { ApiError, fieldErrors } from '../../lib/errors';
import { plural } from '../../lib/format';

export type CodeKind = 'pickup' | 'delivery';

export interface CodeEntryDialogProps {
  open: boolean;
  onClose: () => void;
  kind: CodeKind;
  /** From the job view (`codeAttemptsRemaining`). */
  attemptsRemaining: number;
  /** Resolve on success; throw the ApiError otherwise. */
  onSubmit: (code: string) => Promise<unknown>;
}

const COPY: Record<CodeKind, { title: string; label: string; hint: string; confirm: string }> = {
  pickup: {
    title: 'Enter pickup code',
    label: 'Pickup code',
    hint: 'Ask the restaurant staff for the 4-digit pickup code when you collect the order.',
    confirm: 'Confirm pickup',
  },
  delivery: {
    title: 'Enter delivery code',
    label: 'Delivery code',
    hint: 'Ask the customer for the 4-digit delivery code once you hand over the order.',
    confirm: 'Confirm delivery',
  },
};

function attemptsFrom(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as { attemptsRemaining?: unknown } | undefined;
  return typeof d?.attemptsRemaining === 'number' ? d.attemptsRemaining : null;
}

export function CodeEntryDialog({ open, onClose, kind, attemptsRemaining, onSubmit }: CodeEntryDialogProps) {
  const copy = COPY[kind];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(attemptsRemaining);
  const [locked, setLocked] = useState(attemptsRemaining <= 0);
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCode('');
      setBusy(false);
      setLeft(attemptsRemaining);
      setLocked(attemptsRemaining <= 0);
      setWrong(false);
      setError(null);
    }
    // Re-initialise only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid = /^[0-9]{4}$/.test(code);

  const submit = async () => {
    if (!valid || busy || locked) return;
    setBusy(true);
    setError(null);
    setWrong(false);
    try {
      await onSubmit(code);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DELIVERY_CODE_LOCKED') {
        setLocked(true);
        setLeft(0);
      } else if (e instanceof ApiError && e.code === 'DELIVERY_CODE_INVALID') {
        setWrong(true);
        setLeft(attemptsFrom(e) ?? Math.max(0, left - 1));
        setCode('');
        inputRef.current?.focus();
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const issues = error ? fieldErrors(error) : {};
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={copy.title}
      size="sm"
      dismissible={!busy}
      initialFocusRef={inputRef}
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="handover-code-form" disabled={!valid || locked} loading={busy}>
            {copy.confirm}
          </Button>
        </FormActions>
      }
    >
      <form
        id="handover-code-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={copy.label} hint={copy.hint} error={issues.code} required>
          <Input
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            autoComplete="off"
            disabled={locked}
            className="text-center text-xl tracking-[0.5em] tabular-nums"
          />
        </Field>
        <div aria-live="polite" className="space-y-1 text-sm">
          {locked ? (
            <p role="alert" className="font-medium text-danger-700">
              This code entry is locked after too many wrong attempts. Contact Thali support to continue this delivery.
            </p>
          ) : (
            <>
              {wrong ? <p className="font-medium text-danger-700">That code is wrong.</p> : null}
              <p className={left <= 2 ? 'font-medium text-warn-800' : 'text-slate-600'}>
                {plural(left, 'attempt')} remaining
              </p>
            </>
          )}
        </div>
        {error && Object.keys(issues).length === 0 ? <InlineError error={error} /> : null}
      </form>
    </Dialog>
  );
}
