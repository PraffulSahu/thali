/**
 * File chooser for the presign -> PUT -> attach flow. Validates type/size on the client first (the server
 * verifies again), shows progress as a busy button and surfaces failures inline with a way to retry.
 */
import { useId, useRef, useState } from 'react';
import { Button, InlineError } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { UPLOAD_RULES, UploadError, validateUpload, type UploadPurpose } from './api';

export interface FilePickerProps {
  /** Accessible name of the file input, e.g. "Cover image" or "FSSAI licence". */
  label: string;
  purpose: UploadPurpose;
  buttonLabel?: string;
  disabled?: boolean;
  /** Upload + attach; throw to report a failure. */
  onPick: (file: File) => Promise<void>;
  onDone?: () => void;
}

export function FilePicker({ label, purpose, buttonLabel = 'Choose file', disabled, onPick, onDone }: FilePickerProps) {
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rule = UPLOAD_RULES[purpose];

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const problem = validateUpload(file, purpose);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await onPick(file);
      onDone?.();
    } catch (e) {
      setError(e instanceof UploadError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={ref}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        aria-describedby={hintId}
        accept={rule.types.join(',')}
        disabled={disabled || busy}
        onChange={(e) => void handle(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" icon="plus" loading={busy} disabled={disabled} onClick={() => ref.current?.click()}>
          {busy ? 'Uploading…' : buttonLabel}
        </Button>
        <span id={hintId} className="text-sm text-slate-600">
          {rule.label}
        </span>
      </div>
      {error ? <InlineError error={new Error(error)} /> : null}
    </div>
  );
}
