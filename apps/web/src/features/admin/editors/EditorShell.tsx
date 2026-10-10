/** Shared dialog + save plumbing for the catalog editors. */
import { useState, type ReactNode } from 'react';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { InlineError } from '../../../components/ui/ErrorState';
import { FormActions } from '../../../components/ui/FormActions';
import { fieldErrors } from '../../../lib/errors';
import { createCatalog, updateCatalog, type CatalogKind } from '../api';
import { useAdminMutation } from '../shared';

export function useCatalogSave<T extends { id: string }>(kind: CatalogKind, noun: string, item: T | null | undefined) {
  return useAdminMutation((body: unknown) => (item ? updateCatalog<T>(kind, item.id, body) : createCatalog<T>(kind, body)), {
    success: item ? `${noun} updated` : `${noun} created`,
    invalidate: [['admin', 'catalog', kind]],
  });
}

export interface EditorDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  /** False keeps the submit button disabled; show the reason inline near the fields. */
  valid: boolean;
  onSubmit: () => Promise<unknown>;
  size?: 'sm' | 'md' | 'lg';
  /** Server-side field errors (from `VALIDATION_FAILED`) are passed in so they sit next to the fields. */
  children: (errors: Record<string, string>) => ReactNode;
}

export function EditorDialog({ open, onClose, title, description, submitLabel, valid, onSubmit, size = 'md', children }: EditorDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const formId = 'catalog-editor-form';

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
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
      onClose={() => {
        setError(null);
        onClose();
      }}
      title={title}
      description={description}
      size={size}
      dismissible={!busy}
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy} disabled={!valid}>
            {submitLabel}
          </Button>
        </FormActions>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {children(errors)}
        <InlineError error={error && Object.keys(errors).length === 0 ? error : null} />
        {error && Object.keys(errors).length > 0 ? <InlineError error={new Error('Some fields need attention. Fix the highlighted fields and try again.')} /> : null}
      </form>
    </Dialog>
  );
}
