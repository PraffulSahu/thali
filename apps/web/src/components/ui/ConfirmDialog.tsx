/**
 * Confirmation dialog with optional required reason (reject / suspend / cancel flows). `onConfirm` may be
 * async: the confirm button shows a spinner, the dialog can't be dismissed meanwhile, and a thrown error is
 * shown inline (the dialog stays open so the user can retry). Resolving closes the dialog via `onClose`.
 *
 *   <ConfirmDialog open={open} onClose={close} title="Reject this order?" tone="danger"
 *     description="The customer is refunded for this restaurant's items."
 *     confirmLabel="Reject order"
 *     reason={{ label: 'Reason', options: ['Item out of stock', 'Kitchen closing'], minLength: 3 }}
 *     onConfirm={(reason) => rejectMutation.mutateAsync({ reason })} />
 *
 * `reason.options`: a select with an "Other" choice that reveals a textarea; without options a textarea.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { InlineError } from './ErrorState';
import { Field } from './Field';
import { FormActions } from './FormActions';
import { Textarea } from './Input';
import { Select } from './Select';

export interface ConfirmReasonConfig {
  label?: string;
  placeholder?: string;
  hint?: ReactNode;
  /** Minimum characters (default 3). */
  minLength?: number;
  maxLength?: number;
  /** Preset reasons; "Other" (free text) is appended automatically. */
  options?: string[];
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** Require a reason; it is passed to onConfirm. */
  reason?: ConfirmReasonConfig;
  onConfirm: (reason?: string) => unknown | Promise<unknown>;
  children?: ReactNode;
}

const OTHER = '__other__';

export function ConfirmDialog({
  open, onClose, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', reason, onConfirm, children,
}: ConfirmDialogProps) {
  const [choice, setChoice] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setChoice('');
      setText('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const min = reason?.minLength ?? 3;
  const usingOptions = Boolean(reason?.options?.length);
  const freeText = !usingOptions || choice === OTHER;
  const value = reason ? (freeText ? text.trim() : choice) : undefined;
  const valid = !reason || (value !== undefined && value.length >= (freeText ? min : 1));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(value);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      dismissible={!busy}
      role="alertdialog"
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => void submit()} disabled={!valid} loading={busy}>
            {confirmLabel}
          </Button>
        </FormActions>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {children}
        {reason && usingOptions ? (
          <Field label={reason.label ?? 'Reason'} required>
            <Select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              placeholder="Choose a reason"
              options={[...reason.options!.map((o) => ({ value: o, label: o })), { value: OTHER, label: 'Other' }]}
            />
          </Field>
        ) : null}
        {reason && freeText ? (
          <Field
            label={usingOptions ? 'Describe the reason' : (reason.label ?? 'Reason')}
            required
            hint={reason.hint ?? (min > 1 ? `At least ${min} characters` : undefined)}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={reason.placeholder}
              maxLength={reason.maxLength ?? 500}
              rows={3}
            />
          </Field>
        ) : null}
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
