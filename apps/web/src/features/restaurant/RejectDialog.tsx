/** Reject an incoming order. A reason is required: choose a preset or "Other" and describe it. */
import { ConfirmDialog } from '../../components/ui';

export const REJECT_REASONS = [
  'Item(s) out of stock',
  'Kitchen is too busy',
  'Closing early today',
  "Can't fulfil the special request",
  'Equipment or power problem',
];

export interface RejectDialogProps {
  open: boolean;
  onClose: () => void;
  orderCode: string;
  /** Resolve to close; throw to show the error inline and keep the dialog open. */
  onReject: (reason: string) => Promise<unknown>;
}

export function RejectDialog({ open, onClose, orderCode, onReject }: RejectDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone="danger"
      title={`Reject order ${orderCode}?`}
      description="The customer is told why and refunded for this order. This can't be undone."
      confirmLabel="Reject order"
      reason={{ label: 'Reason', options: REJECT_REASONS, minLength: 3, placeholder: 'Tell the customer what happened' }}
      onConfirm={(reason) => onReject(reason ?? '')}
    />
  );
}
