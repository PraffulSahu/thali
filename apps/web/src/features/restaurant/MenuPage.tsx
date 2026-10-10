/**
 * Menu management (PRD R-3): categories, items, availability toggle and tracked stock. Customization groups are
 * edited in the item editor. All data is the owner's real menu from the marketplace service.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, Field, FoodMarker, FormActions, IconButton, InlineError, Input, PageHeader,
  Price, QueryState, Skeleton, Switch, useToast,
} from '../../components/ui';
import { ApiError, fieldErrors } from '../../lib/errors';
import { ItemEditor } from './ItemEditor';
import { keys, menuApi, type MenuCategory, type OwnerItem } from './api';
import { useCurrentRestaurant } from './RestaurantContext';

/** Categories are kept at 10, 20, 30... so the list order is always explicit. */
export const sortOrderAt = (index: number) => (index + 1) * 10;

function CategoryDialog({ open, onClose, restaurantId, category, nextSortOrder, onSaved }: { open: boolean; onClose: () => void; restaurantId: string; category?: MenuCategory; nextSortOrder: number; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [active, setActive] = useState(category?.active ?? true);
  const [show, setShow] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      category
        ? menuApi.updateCategory(restaurantId, category.id, { name: name.trim(), active })
        : menuApi.createCategory(restaurantId, { name: name.trim(), active, sortOrder: nextSortOrder }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const nameError = !name.trim() ? 'Enter a category name.' : name.trim().length > 80 ? 'Use 80 characters or fewer.' : undefined;
  const server = fieldErrors(save.error);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      dismissible={!save.isPending}
      title={category ? 'Edit category' : 'Add category'}
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="category-form" loading={save.isPending}>{category ? 'Save' : 'Add category'}</Button>
        </FormActions>
      }
    >
      <form
        id="category-form"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameError) return setShow(true);
          save.mutate();
        }}
      >
        <Field label="Category name" required error={(show ? nameError : undefined) ?? server.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Starters" />
        </Field>
        <Switch label="Visible to customers" description="Hidden categories keep their items but aren't shown" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {save.isError && !server.name ? <InlineError error={save.error} /> : null}
      </form>
    </Dialog>
  );
}

function StockControl({ item, restaurantId, onChanged }: { item: OwnerItem; restaurantId: string; onChanged: () => void }) {
  const [text, setText] = useState(String(item.stockQty));
  const valid = /^\d+$/.test(text.trim());
  const dirty = text.trim() !== String(item.stockQty);
  const save = useMutation({ mutationFn: () => menuApi.setAvailability(restaurantId, item.id, { stockQty: Number(text) }), onSuccess: onChanged });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Stock for ${item.name}`} className="w-28" error={dirty && !valid ? 'Whole number' : undefined}>
          <Input type="number" inputMode="numeric" min={0} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {dirty ? (
          <Button size="sm" variant="secondary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            Update stock
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-slate-600">
        {item.availableQty ?? item.stockQty} available{item.reservedQty > 0 ? `, ${item.reservedQty} held in open orders` : ''}
      </p>
      <InlineError error={save.error} />
    </div>
  );
}

function ItemRow({ item, restaurantId, onEdit, onDelete, onChanged }: { item: OwnerItem; restaurantId: string; onEdit: () => void; onDelete: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const toggle = useMutation({
    mutationFn: (available: boolean) => menuApi.setAvailability(restaurantId, item.id, { available }),
    onSuccess: (_d, available) => {
      toast({ title: `${item.name} ${available ? 'is available' : 'is hidden from customers'}`, tone: 'success' });
      onChanged();
    },
  });
  const soldOut = item.trackStock && (item.availableQty ?? item.stockQty) <= 0;
  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex items-start gap-3">
        {item.imageUrl ? <img src={item.imageUrl} alt="" className="size-16 shrink-0 rounded-control object-cover" /> : null}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
            <FoodMarker veg={item.isVeg} /> {item.name}
            {soldOut ? <Badge tone="warn">Out of stock</Badge> : null}
            {!item.available ? <Badge tone="neutral">Hidden</Badge> : null}
          </p>
          {item.description ? <p className="line-clamp-2 text-sm text-slate-600">{item.description}</p> : null}
          <p className="mt-0.5 flex items-center gap-2 text-sm">
            <Price paise={item.pricePaise} />
            {item.customizationGroups.length > 0 ? <span className="text-slate-600">· {item.customizationGroups.length} customization {item.customizationGroups.length === 1 ? 'group' : 'groups'}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton icon="edit" label={`Edit ${item.name}`} onClick={onEdit} />
          <IconButton icon="trash" label={`Delete ${item.name}`} onClick={onDelete} />
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Switch
          label={`${item.name} available`}
          checked={item.available}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        {item.trackStock ? <StockControl key={item.stockQty} item={item} restaurantId={restaurantId} onChanged={onChanged} /> : null}
      </div>
      <InlineError error={toggle.error} />
    </li>
  );
}

export default function MenuPage() {
  const r = useCurrentRestaurant();
  const qc = useQueryClient();
  const { toast } = useToast();
  const cats = useQuery({ queryKey: keys.categories(r.id), queryFn: () => menuApi.categories(r.id) });
  const items = useQuery({ queryKey: keys.items(r.id), queryFn: () => menuApi.items(r.id) });
  const [catDialog, setCatDialog] = useState<{ category?: MenuCategory } | null>(null);
  const [itemDialog, setItemDialog] = useState<{ item?: OwnerItem; categoryId?: string } | null>(null);
  const [delCat, setDelCat] = useState<MenuCategory | null>(null);
  const [delItem, setDelItem] = useState<OwnerItem | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.categories(r.id) });
    void qc.invalidateQueries({ queryKey: keys.items(r.id) });
  };

  const move = useMutation({
    mutationFn: async ({ list, index, dir }: { list: MenuCategory[]; index: number; dir: -1 | 1 }) => {
      const order = [...list];
      const j = index + dir;
      [order[index], order[j]] = [order[j]!, order[index]!];
      // renumber the whole list in its new order so ties and gaps can never scramble it
      await Promise.all(
        order.flatMap((c, i) => (c.sortOrder === sortOrderAt(i) ? [] : [menuApi.updateCategory(r.id, c.id, { sortOrder: sortOrderAt(i) })])),
      );
    },
    onSuccess: refresh,
  });

  // QueryState expects one query: combine the two
  const combined = {
    data: cats.data && items.data ? { cats: [...cats.data].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), items: items.data } : undefined,
    isPending: cats.isPending || items.isPending,
    isError: cats.isError || items.isError,
    error: cats.error ?? items.error,
    isFetching: cats.isFetching || items.isFetching,
    refetch: () => Promise.all([cats.refetch(), items.refetch()]),
  };

  return (
    <>
      <PageHeader
        title="Menu"
        description={`What ${r.name} serves`}
        actions={
          <>
            <Button variant="secondary" icon="plus" onClick={() => setCatDialog({})}>Add category</Button>
            <Button icon="plus" disabled={!cats.data?.length} onClick={() => setItemDialog({})}>Add item</Button>
          </>
        }
      />
      {cats.data && cats.data.length === 0 ? <p className="mb-3 text-sm text-slate-600">Add a category first, then add items to it.</p> : null}
      <InlineError error={move.error} className="mb-3" />
      <QueryState
        query={combined}
        loading={<div className="flex flex-col gap-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>}
        loadingLabel="Loading your menu…"
        isEmpty={(d) => d.cats.length === 0}
        empty={{
          icon: 'list',
          title: 'Your menu is empty',
          description: 'Start with a category such as Starters or Mains, then add your dishes.',
          action: <Button icon="plus" onClick={() => setCatDialog({})}>Add your first category</Button>,
        }}
      >
        {({ cats: list, items: all }) => (
          <div className="flex flex-col gap-4">
            {list.map((c, idx) => {
              const inCat = all.filter((i) => i.categoryId === c.id);
              return (
                <Card key={c.id} as="section" aria-label={c.name}>
                  <CardHeader
                    title={<span className="flex items-center gap-2">{c.name}{!c.active ? <Badge tone="neutral">Hidden</Badge> : null}</span>}
                    description={`${inCat.length} ${inCat.length === 1 ? 'item' : 'items'}`}
                    actions={
                      <>
                        <IconButton icon="chevron-up" label={`Move ${c.name} up`} disabled={idx === 0 || move.isPending} onClick={() => move.mutate({ list, index: idx, dir: -1 })} />
                        <IconButton icon="chevron-down" label={`Move ${c.name} down`} disabled={idx === list.length - 1 || move.isPending} onClick={() => move.mutate({ list, index: idx, dir: 1 })} />
                        <Button variant="ghost" size="sm" icon="edit" onClick={() => setCatDialog({ category: c })} aria-label={`Edit category ${c.name}`}>Edit</Button>
                        <Button variant="ghost" size="sm" icon="trash" onClick={() => setDelCat(c)} aria-label={`Delete category ${c.name}`}>Delete</Button>
                      </>
                    }
                  />
                  {inCat.length === 0 ? (
                    <EmptyState compact icon="plus" title="No items here yet" action={<Button variant="secondary" size="sm" icon="plus" onClick={() => setItemDialog({ categoryId: c.id })}>Add item to {c.name}</Button>} />
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100">
                      {inCat.map((i) => (
                        <ItemRow key={i.id} item={i} restaurantId={r.id} onEdit={() => setItemDialog({ item: i })} onDelete={() => setDelItem(i)} onChanged={refresh} />
                      ))}
                    </ul>
                  )}
                  {inCat.length > 0 ? (
                    <div className="mt-2">
                      <Button variant="link" size="sm" icon="plus" onClick={() => setItemDialog({ categoryId: c.id })}>Add item to {c.name}</Button>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </QueryState>

      {catDialog ? (
        <CategoryDialog key={catDialog.category?.id ?? 'new'} open onClose={() => setCatDialog(null)} restaurantId={r.id} category={catDialog.category} nextSortOrder={sortOrderAt(cats.data?.length ?? 0)} onSaved={() => { refresh(); toast({ title: 'Category saved', tone: 'success' }); }} />
      ) : null}
      {itemDialog && cats.data ? (
        <ItemEditor
          key={itemDialog.item?.id ?? `new-${itemDialog.categoryId ?? ''}`}
          open
          onClose={() => setItemDialog(null)}
          restaurantId={r.id}
          categories={cats.data}
          item={itemDialog.item}
          defaultCategoryId={itemDialog.categoryId}
          onSaved={(saved) => { refresh(); toast({ title: `${saved.name} saved`, tone: 'success' }); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(delCat)}
        onClose={() => setDelCat(null)}
        tone="danger"
        title={`Delete category ${delCat?.name ?? ''}?`}
        description="Only empty categories can be deleted. Move or delete its items first."
        confirmLabel="Delete category"
        onConfirm={async () => {
          try {
            await menuApi.deleteCategory(r.id, delCat!.id);
          } catch (e) {
            if (e instanceof ApiError && e.code === 'CONFLICT') throw new Error('This category still has items. Move or delete them first.');
            throw e;
          }
          refresh();
          toast({ title: 'Category deleted', tone: 'success' });
        }}
      />
      <ConfirmDialog
        open={Boolean(delItem)}
        onClose={() => setDelItem(null)}
        tone="danger"
        title={`Delete ${delItem?.name ?? 'item'}?`}
        description="It disappears from your menu. Past orders keep their own copy of the item."
        confirmLabel="Delete item"
        onConfirm={async () => {
          await menuApi.deleteItem(r.id, delItem!.id);
          refresh();
          toast({ title: 'Item deleted', tone: 'success' });
        }}
      />
    </>
  );
}
