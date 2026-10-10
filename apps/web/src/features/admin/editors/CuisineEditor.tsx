import { useEffect, useState } from 'react';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Field } from '../../../components/ui/Field';
import { Input } from '../../../components/ui/Input';
import type { Cuisine } from '../api';
import { EditorDialog, useCatalogSave } from './EditorShell';
import ImageField from './ImageField';

export default function CuisineEditor({ open, item, onClose }: { open: boolean; item: Cuisine | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const save = useCatalogSave<Cuisine>('cuisines', 'Cuisine', item);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? '');
    setSlug(item?.slug ?? '');
    setSortOrder(String(item?.sortOrder ?? 0));
    setActive(item?.active ?? true);
    setImageKey(item?.imageKey ?? null);
  }, [open, item]);

  const order = /^\d{1,5}$/.test(sortOrder) ? Number(sortOrder) : null;
  const slugOk = slug === '' || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
  const valid = name.trim().length > 0 && order !== null && order <= 10000 && slugOk;

  return (
    <EditorDialog
      open={open}
      onClose={onClose}
      title={item ? `Edit ${item.name}` : 'Add a cuisine'}
      submitLabel={item ? 'Save changes' : 'Add cuisine'}
      valid={valid}
      onSubmit={() =>
        save.mutateAsync({ name: name.trim(), ...(slug ? { slug } : {}), sortOrder: order, active, ...(imageKey ? { imageKey } : {}) })
      }
    >
      {(errors) => (
        <>
          <Field label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Slug" optional hint="Lowercase letters, digits and dashes. Generated from the name if empty." error={!slugOk ? 'Use lowercase letters, digits and single dashes.' : errors.slug}>
            <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={40} />
          </Field>
          <Field label="Sort order" required hint="Lower numbers appear first" error={errors.sortOrder}>
            <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
          <ImageField imageKey={imageKey} previewUrl={item?.imageUrl} onChange={(k) => setImageKey(k)} error={errors.imageKey} />
          <Checkbox label="Active" description="Inactive cuisines are hidden from discovery filters" checked={active} onChange={(e) => setActive(e.target.checked)} />
        </>
      )}
    </EditorDialog>
  );
}
