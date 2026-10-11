/** Image picker for catalog images: presign, PUT to storage, hand back the object key. */
import { useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { InlineError } from '../../../components/ui/ErrorState';
import { uploadCatalogImage } from '../api';

const MAX_BYTES = 2 * 1024 * 1024;

export default function ImageField({ label = 'Image', imageKey, previewUrl, onChange, required, error }: {
  label?: string;
  imageKey: string | null;
  previewUrl?: string | null;
  onChange: (key: string, localPreview: string) => void;
  required?: boolean;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [local, setLocal] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setProblem(new Error('Use a JPEG, PNG or WebP image.'));
    if (file.size > MAX_BYTES) return setProblem(new Error('The image must be 2 MB or smaller.'));
    setBusy(true);
    try {
      const key = await uploadCatalogImage(file);
      const url = URL.createObjectURL(file);
      setLocal(url);
      onChange(key, url);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const shown = local ?? previewUrl ?? null;
  return (
    <Field label={label} required={required} hint="JPEG, PNG or WebP, up to 2 MB" error={error}>
      <div className="flex flex-wrap items-center gap-3">
        {shown ? <img src={shown} alt="" className="size-16 rounded-control border border-line object-cover" /> : null}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label={`${label} file`}
          tabIndex={-1}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button type="button" variant="outline" loading={busy} onClick={() => input.current?.click()}>
          {imageKey ? 'Replace image' : 'Choose image'}
        </Button>
        {imageKey ? <span className="text-sm text-fg-3">Uploaded</span> : null}
      </div>
      <InlineError error={problem} className="mt-1" />
    </Field>
  );
}
