import { useEffect, useState } from 'react';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { isoToIstInput, istInputToIso, type Banner } from '../api';
import { EditorDialog, useCatalogSave } from './EditorShell';
import ImageField from './ImageField';

const LINK_HINTS = {
  RESTAURANT: 'Restaurant slug, like biryani-house',
  CUISINE: 'Cuisine slug, like south-indian',
  COUPON: 'Coupon code, like WELCOME50',
} as const;

export default function BannerEditor({ open, item, onClose }: { open: boolean; item: Banner | null; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<Banner['linkType']>('RESTAURANT');
  const [linkValue, setLinkValue] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [active, setActive] = useState(true);
  const save = useCatalogSave<Banner>('banners', 'Banner', item);

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setImageKey(item?.imageKey ?? null);
    setLinkType(item?.linkType ?? 'RESTAURANT');
    setLinkValue(item?.linkValue ?? '');
    setFrom(isoToIstInput(item?.activeFrom));
    setTo(isoToIstInput(item?.activeTo));
    setActive(item?.active ?? true);
  }, [open, item]);

  const fromIso = istInputToIso(from);
  const toIso = istInputToIso(to);
  const rangeError = fromIso && toIso && new Date(toIso) <= new Date(fromIso) ? 'The end must be after the start.' : undefined;
  const valid = title.trim().length > 0 && !!imageKey && linkValue.trim().length > 0 && !!fromIso && !!toIso && !rangeError;

  return (
    <EditorDialog
      open={open}
      onClose={onClose}
      title={item ? 'Edit banner' : 'Add a banner'}
      submitLabel={item ? 'Save changes' : 'Add banner'}
      valid={valid}
      onSubmit={() => save.mutateAsync({ title: title.trim(), imageKey, linkType, linkValue: linkValue.trim(), activeFrom: fromIso, activeTo: toIso, active })}
    >
      {(errors) => (
        <>
          <Field label="Title" required error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
          <ImageField required imageKey={imageKey} previewUrl={item?.imageUrl} onChange={(k) => setImageKey(k)} error={errors.imageKey} />
          <Field label="Links to" required>
            <Select value={linkType} onChange={(e) => setLinkType(e.target.value as Banner['linkType'])} options={[{ value: 'RESTAURANT', label: 'A restaurant' }, { value: 'CUISINE', label: 'A cuisine' }, { value: 'COUPON', label: 'A coupon' }]} />
          </Field>
          <Field label="Link target" required hint={LINK_HINTS[linkType]} error={errors.linkValue}>
            <Input value={linkValue} onChange={(e) => setLinkValue(e.target.value)} maxLength={120} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Shows from (IST)" required error={errors.activeFrom}>
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Shows until (IST)" required error={rangeError ?? errors.activeTo}>
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <Checkbox label="Active" description="Inactive banners are never shown, even inside the date range" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </>
      )}
    </EditorDialog>
  );
}
