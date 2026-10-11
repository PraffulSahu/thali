/**
 * File chooser for the presign -> PUT -> attach flow. Validates type/size on the client first (the server
 * verifies again), shows the file chip with a stage progress bar (sending → done; fetch gives no byte progress)
 * and surfaces failures inline with a way to retry.
 */
import { useId, useRef, useState } from 'react';
import { Button, Icon, InlineError, ProgressBar } from '../../components/ui';
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
  const [file, setFile] = useState<{ name: string; size: number; done: boolean } | null>(null);
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
    setFile({ name: file.name, size: file.size, done: false });
    try {
      await onPick(file);
      setFile({ name: file.name, size: file.size, done: true });
      onDone?.();
    } catch (e) {
      setFile(null);
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
        <Button variant="outline" size="sm" icon="plus" loading={busy} disabled={disabled} onClick={() => ref.current?.click()}>
          {busy ? 'Uploading…' : buttonLabel}
        </Button>
        <span id={hintId} className="text-sm text-fg-3">
          {rule.label}
        </span>
      </div>
      {file ? (
        <div className="flex max-w-md flex-col gap-1.5 rounded-item border border-line bg-bg-2 px-3 py-2">
          <span className="flex items-center gap-2 text-[13px] text-fg-2">
            <Icon name={file.done ? 'check' : 'receipt'} size={14} className={file.done ? 'text-ok' : 'text-fg-3'} />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="font-mono text-[11.5px] text-fg-3">{Math.max(1, Math.round(file.size / 1024))} KB</span>
          </span>
          <ProgressBar value={file.done ? 2 : 1} max={2} tone={file.done ? 'ok' : 'acc'} label={`Upload of ${file.name}`} left={file.done ? 'Uploaded' : 'Uploading…'} />
        </div>
      ) : null}
      {error ? <InlineError error={new Error(error)} /> : null}
    </div>
  );
}
