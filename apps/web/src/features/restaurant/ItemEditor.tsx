/**
 * Create / edit a menu item (PRD R-3): name, category, price, veg flag, image, availability, tracked stock,
 * recommended (MKT-9, max 6) and customization groups. Validation mirrors the API (min <= max <= options). In a
 * pure-veg kitchen (MKT-4) the item and every option are vegetarian; a 422 PURE_VEG_VIOLATION is explained.
 * Saves with POST/PATCH on /owner/restaurants/:id/items. Dialog on desktop, bottom sheet on phones.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Field, FormActions, InlineError, Input, RadioGroup, Select, Switch, Textarea } from '../../components/ui';
import { ApiError, fieldErrors } from '../../lib/errors';
import { FilePicker } from './FilePicker';
import {
  CustomizationEditor, fromDraftGroups, toDraftGroups, validateGroups, type DraftGroup,
} from './CustomizationEditor';
import { MAX_FEATURED, menuApi, paiseToRupees, rupeesToPaise, uploadFile, type ItemBody, type MenuCategory, type OwnerItem } from './api';

export interface ItemEditorProps {
  open: boolean;
  onClose: () => void;
  restaurantId: string;
  categories: MenuCategory[];
  /** Editing when set, creating otherwise. */
  item?: OwnerItem;
  defaultCategoryId?: string;
  /** Restaurant is declared pure veg: items and options must be vegetarian. */
  pureVeg?: boolean;
  /** Featured items in the menu right now (cap MAX_FEATURED). */
  featuredCount?: number;
  onSaved: (item: OwnerItem) => void;
}

/** Human message for a server refusal the form can't map to one field. */
export function itemSaveError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'PURE_VEG_VIOLATION') return 'This is a pure-veg kitchen, so the item and all of its options must be vegetarian. Change them, or turn off "Pure veg" in Store settings.';
  if (e.code === 'VALIDATION_FAILED' && /featured/i.test(JSON.stringify(e.details ?? '') + e.message)) return `You can recommend up to ${MAX_FEATURED} items. Remove one from recommended first.`;
  return null;
}

interface Values {
  name: string;
  description: string;
  categoryId: string;
  price: string;
  isVeg: 'veg' | 'nonveg';
  available: boolean;
  trackStock: boolean;
  stock: string;
  featured: boolean;
  imageKey: string | null | undefined;
}

export function validateItem(v: Values, reservedQty = 0): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.name.trim()) e.name = 'Enter the item name.';
  else if (v.name.trim().length > 80) e.name = 'Use 80 characters or fewer.';
  if (!v.categoryId) e.categoryId = 'Choose a category.';
  if (rupeesToPaise(v.price) === null) e.price = 'Enter a price like 249 or 249.50.';
  if (v.description.trim().length > 500) e.description = 'Use 500 characters or fewer.';
  if (v.trackStock) {
    if (!/^\d+$/.test(v.stock.trim())) e.stock = 'Enter the stock as a whole number, 0 or more.';
    else if (Number(v.stock) < reservedQty) e.stock = `${reservedQty} are held in open orders, so stock can't go below that.`;
  }
  return e;
}

export function ItemEditor({ open, onClose, restaurantId, categories, item, defaultCategoryId, pureVeg = false, featuredCount = 0, onSaved }: ItemEditorProps) {
  const [v, setV] = useState<Values>(() => ({
    name: item?.name ?? '',
    description: item?.description ?? '',
    categoryId: item?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? '',
    price: item ? paiseToRupees(item.pricePaise) : '',
    isVeg: pureVeg ? 'veg' : item ? (item.isVeg ? 'veg' : 'nonveg') : 'veg',
    available: item?.available ?? true,
    trackStock: item?.trackStock ?? false,
    stock: String(item?.stockQty ?? 0),
    featured: Boolean(item?.featured),
    imageKey: undefined,
  }));
  const [groups, setGroups] = useState<DraftGroup[]>(() => toDraftGroups(item?.customizationGroups ?? []));
  const [preview, setPreview] = useState<string | null>(item?.imageUrl ?? null);
  const [show, setShow] = useState(false);
  // local preview URLs must be released, or each chosen photo leaks until the tab closes
  const objectUrl = useRef<string | null>(null);
  const releasePreview = () => {
    if (objectUrl.current && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  useEffect(() => releasePreview, []);

  const errors = validateItem(v, item?.reservedQty ?? 0);
  const groupErrors = validateGroups(groups);
  // min/max rules are shown as the owner types; "required" errors wait until they try to save
  const liveGroupErrors = Object.fromEntries(Object.entries(groupErrors).filter(([k]) => /\.(min|max)$/.test(k)));
  const hasErrors = Object.keys(errors).length > 0 || Object.keys(groupErrors).length > 0;

  const save = useMutation({
    mutationFn: () => {
      const body: ItemBody = {
        categoryId: v.categoryId,
        name: v.name.trim(),
        description: v.description.trim(),
        pricePaise: rupeesToPaise(v.price)!,
        isVeg: v.isVeg === 'veg',
        available: v.available,
        trackStock: v.trackStock,
        ...(v.trackStock ? { stockQty: Number(v.stock) } : {}),
        ...(v.imageKey !== undefined ? { imageKey: v.imageKey } : {}),
        ...(v.featured !== Boolean(item?.featured) ? { featured: v.featured } : {}),
        customizationGroups: fromDraftGroups(pureVeg ? groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, isVeg: true })) })) : groups),
      };
      return item
        ? menuApi.updateItem(restaurantId, item.id, body)
        : menuApi.createItem(restaurantId, body as ItemBody & { categoryId: string; name: string; pricePaise: number; isVeg: boolean });
    },
    onSuccess: (saved) => {
      onSaved(saved);
      onClose();
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string, serverKey = k) => (show ? errors[k] : undefined) ?? server[serverKey];
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((p) => ({ ...p, [k]: val }));

  const submit = () => {
    if (hasErrors) {
      setShow(true);
      return;
    }
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissible={!save.isPending}
      title={item ? `Edit ${item.name}` : 'Add menu item'}
      description="Changes go live for customers as soon as you save."
      footer={
        <FormActions>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="item-editor-form" loading={save.isPending}>{item ? 'Save changes' : 'Add item'}</Button>
        </FormActions>
      }
    >
      <form
        id="item-editor-form"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Item name" required error={err('name')}>
          <Input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" required error={err('categoryId')}>
            <Select value={v.categoryId} onChange={(e) => set('categoryId', e.target.value)} placeholder="Choose a category" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label="Price" required error={err('price', 'pricePaise')}>
            <Input inputMode="decimal" prefix="₹" value={v.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
        </div>
        <Field label="Description" optional error={err('description')}>
          <Textarea rows={3} maxLength={500} value={v.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <RadioGroup
          legend="Food type"
          name="item-veg"
          value={v.isVeg}
          onChange={(x) => set('isVeg', x as Values['isVeg'])}
          options={[{ value: 'veg', label: 'Vegetarian' }, { value: 'nonveg', label: 'Non-vegetarian', disabled: pureVeg }]}
        />
        {pureVeg ? <p className="-mt-2 text-[13px] text-fg-3">Pure-veg kitchen: every item and option is vegetarian. Change this in Store settings.</p> : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg">Photo</p>
          {preview ? <img src={preview} alt="Item preview" className="h-32 w-32 rounded-control border border-line object-cover" /> : null}
          <FilePicker
            label="Item photo"
            purpose="IMAGE"
            buttonLabel={preview ? 'Replace photo' : 'Upload photo'}
            onPick={async (file) => {
              const key = await uploadFile(restaurantId, file, 'IMAGE');
              set('imageKey', key);
              if (typeof URL.createObjectURL === 'function') {
                releasePreview();
                objectUrl.current = URL.createObjectURL(file);
                setPreview(objectUrl.current);
              }
            }}
          />
          {preview ? (
            <div>
              <Button variant="link" size="sm" onClick={() => { releasePreview(); set('imageKey', null); setPreview(null); }}>Remove photo</Button>
            </div>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-1 rounded-field border border-line bg-bg-2 p-3">
          <legend className="px-1 text-sm font-semibold text-fg">Availability and stock</legend>
          <Switch label="Available to order" description="Turn off to hide this item from customers without deleting it" checked={v.available} onChange={(e) => set('available', e.target.checked)} />
          <Checkbox label="Track stock" description="Stops orders automatically when stock runs out" checked={v.trackStock} onChange={(e) => set('trackStock', e.target.checked)} />
          {v.trackStock ? (
            <Field label="Units in stock" error={err('stock', 'stockQty')} hint={item && item.reservedQty > 0 ? `${item.reservedQty} held in open orders` : undefined}>
              <Input type="number" inputMode="numeric" min={0} value={v.stock} onChange={(e) => set('stock', e.target.value)} />
            </Field>
          ) : null}
          <Checkbox
            label="Recommended"
            description={!v.featured && featuredCount >= MAX_FEATURED && !item?.featured ? `Recommended is full (${MAX_FEATURED} of ${MAX_FEATURED}). Remove one first.` : `Shown in the "Recommended" row at the top of your menu (${featuredCount} of ${MAX_FEATURED} used)`}
            checked={v.featured}
            disabled={!v.featured && featuredCount >= MAX_FEATURED && !item?.featured}
            onChange={(e) => set('featured', e.target.checked)}
          />
        </fieldset>

        <section aria-labelledby="custom-heading" className="flex flex-col gap-2">
          <h3 id="custom-heading" className="font-sans text-base font-semibold tracking-normal text-fg">Customizations and add-ons</h3>
          <CustomizationEditor value={groups} onChange={setGroups} errors={show ? groupErrors : liveGroupErrors} defaultVeg={v.isVeg === 'veg'} vegOnly={pureVeg} />
        </section>

        {show && hasErrors ? <p role="alert" className="text-sm font-medium text-bad">Fix the highlighted fields to save this item.</p> : null}
        {itemSaveError(save.error) ? (
          <p role="alert" className="rounded-item bg-bad-bg px-3 py-2 text-[13px] text-bad">{itemSaveError(save.error)}</p>
        ) : save.isError && Object.keys(server).length === 0 ? (
          <InlineError error={save.error} />
        ) : null}
      </form>
    </Dialog>
  );
}
