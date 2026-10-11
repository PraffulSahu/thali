/**
 * Menu (design-spec §7.3). Two columns: categories (counts, reorder up/down, visible switch, edit, delete) |
 * the selected category's items (veg mark, photo, price, "12 left · 3 reserved" stock, featured star (MKT-9,
 * max 6), availability switch, edit, delete). Pure-veg kitchens (MKT-4) are flagged in the header; the item
 * editor enforces it and explains a 422 PURE_VEG_VIOLATION. `?item=<id>` (dashboard "Update stock") selects
 * that item's category and highlights the row.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, FoodMarker, FormActions, Icon, IconButton, InlineError, Input, PageHeader,
  Price, PureVegBadge, Skeleton, Switch, Toggle, useToast, Field,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { ApiError, errorMessage, fieldErrors } from '../../lib/errors';
import { ItemEditor, itemSaveError } from './ItemEditor';
import { MAX_FEATURED, keys, menuApi, type MenuCategory, type OwnerItem } from './api';
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
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
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
  const valid = /^\d+$/.test(text.trim()) && Number(text) >= item.reservedQty;
  const dirty = text.trim() !== String(item.stockQty);
  const save = useMutation({ mutationFn: () => menuApi.setAvailability(restaurantId, item.id, { stockQty: Number(text) }), onSuccess: onChanged });
  const left = item.availableQty ?? Math.max(0, item.stockQty - item.reservedQty);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('font-mono text-xs', left <= 0 ? 'text-bad' : left <= 5 ? 'text-warn' : 'text-fg-3')}>
          {left} left · {item.reservedQty} reserved
        </span>
        <label className="sr-only" htmlFor={`stock-${item.id}`}>
          Stock for {item.name}
        </label>
        <span className="w-[88px]">
        <Input
          id={`stock-${item.id}`}
          density="compact"
          type="number"
          inputMode="numeric"
          min={item.reservedQty}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-8! px-2.5 font-mono text-[13px]"
          aria-invalid={dirty && !valid ? true : undefined}
        />
        </span>
        {dirty ? (
          <Button size="xs" variant="outline" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            Update stock
          </Button>
        ) : null}
      </div>
      {dirty && !valid ? (
        <p className="text-xs text-bad">{item.reservedQty > 0 ? `Whole number, at least ${item.reservedQty} (held in open orders).` : 'Whole number, 0 or more.'}</p>
      ) : null}
      <InlineError error={save.error} />
    </div>
  );
}

function ItemRow({ item, restaurantId, featuredCount, highlight, onEdit, onDelete, onChanged }: { item: OwnerItem; restaurantId: string; featuredCount: number; highlight?: boolean; onEdit: () => void; onDelete: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlight]);
  const toggle = useMutation({
    mutationFn: (available: boolean) => menuApi.setAvailability(restaurantId, item.id, { available }),
    onSuccess: (_d, available) => {
      toast({ title: `${item.name} ${available ? 'is available' : 'is hidden from customers'}`, tone: 'success' });
      onChanged();
    },
  });
  const feature = useMutation({
    mutationFn: (featured: boolean) => menuApi.updateItem(restaurantId, item.id, { featured }),
    onSuccess: (_d, featured) => {
      toast({ title: featured ? `${item.name} is now recommended` : `${item.name} removed from recommended`, tone: 'success' });
      onChanged();
    },
    onError: (e) => toast({ title: "Couldn't change recommended", description: itemSaveError(e) ?? errorMessage(e), tone: 'danger' }),
  });
  const featured = Boolean(item.featured);
  const atCap = !featured && featuredCount >= MAX_FEATURED;
  const soldOut = item.trackStock && (item.availableQty ?? item.stockQty - item.reservedQty) <= 0;
  return (
    <li ref={ref} className={cn('flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-0', highlight && 'bg-acc-soft')}>
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" className="size-14 shrink-0 rounded-item object-cover" />
      ) : (
        <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-item bg-fill text-fg-3">
          <Icon name="bowl" size={20} />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-medium text-fg">
          <FoodMarker veg={item.isVeg} size={13} />
          <span className="sr-only">{item.isVeg ? 'Veg' : 'Non-veg'}</span>
          {item.name}
          {featured ? <Badge tone="acc" density="dense">Recommended</Badge> : null}
          {soldOut ? <Badge tone="warn" density="dense">Out of stock</Badge> : null}
          {!item.available ? <Badge tone="neutral" density="dense">Hidden</Badge> : null}
        </p>
        {item.description ? <p className="line-clamp-1 text-[13px] text-fg-3">{item.description}</p> : null}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-3">
          <Price paise={item.pricePaise} size="sm" className="text-fg" />
          {item.customizationGroups.length > 0 ? <span>· {item.customizationGroups.length} customization {item.customizationGroups.length === 1 ? 'group' : 'groups'}</span> : null}
        </p>
        {item.trackStock ? (
          <div className="mt-1.5">
            <StockControl key={item.stockQty} item={item} restaurantId={restaurantId} onChanged={onChanged} />
          </div>
        ) : null}
        <InlineError error={toggle.error} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          icon="star"
          size="sm"
          label={featured ? `Remove ${item.name} from recommended` : atCap ? `Recommended is full (${MAX_FEATURED})` : `Recommend ${item.name}`}
          aria-pressed={featured}
          disabled={atCap || feature.isPending}
          onClick={() => feature.mutate(!featured)}
          className={featured ? 'text-acc [&_svg]:fill-current' : 'text-fg-3'}
        />
        <Toggle checked={item.available} onChange={(v) => toggle.mutate(v)} pending={toggle.isPending} label={`${item.name} available`} />
        <IconButton icon="edit" size="sm" label={`Edit ${item.name}`} onClick={onEdit} />
        <IconButton icon="trash" size="sm" label={`Delete ${item.name}`} onClick={onDelete} />
      </div>
    </li>
  );
}

function MenuSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[260px_1fr]" aria-hidden="true">
      <Skeleton className="h-64 rounded-field" />
      <Skeleton className="h-96 rounded-field" />
    </div>
  );
}

export default function MenuPage() {
  const r = useCurrentRestaurant();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sp] = useSearchParams();
  const focusItem = sp.get('item');
  const cats = useQuery({ queryKey: keys.categories(r.id), queryFn: () => menuApi.categories(r.id) });
  const items = useQuery({ queryKey: keys.items(r.id), queryFn: () => menuApi.items(r.id) });
  const [selected, setSelected] = useState<string | null>(null);
  const [catDialog, setCatDialog] = useState<{ category?: MenuCategory } | null>(null);
  const [itemDialog, setItemDialog] = useState<{ item?: OwnerItem; categoryId?: string } | null>(null);
  const [delCat, setDelCat] = useState<MenuCategory | null>(null);
  const [delItem, setDelItem] = useState<OwnerItem | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.categories(r.id) });
    void qc.invalidateQueries({ queryKey: keys.items(r.id) });
    void qc.invalidateQueries({ queryKey: keys.dashboard(r.id) });
  };

  const move = useMutation({
    mutationFn: async ({ list, index, dir }: { list: MenuCategory[]; index: number; dir: -1 | 1 }) => {
      const order = [...list];
      const j = index + dir;
      [order[index], order[j]] = [order[j]!, order[index]!];
      // renumber the whole list in its new order so ties and gaps can never scramble it
      await Promise.all(order.flatMap((c, i) => (c.sortOrder === sortOrderAt(i) ? [] : [menuApi.updateCategory(r.id, c.id, { sortOrder: sortOrderAt(i) })])));
    },
    onSuccess: refresh,
  });
  const setActive = useMutation({
    mutationFn: ({ c, active }: { c: MenuCategory; active: boolean }) => menuApi.updateCategory(r.id, c.id, { active }),
    onSuccess: (_d, { c, active }) => {
      toast({ title: `${c.name} ${active ? 'is visible' : 'is hidden from customers'}`, tone: 'success' });
      refresh();
    },
    onError: (e) => toast({ title: "Couldn't change the category", description: errorMessage(e), tone: 'danger' }),
  });

  const list = cats.data ? [...cats.data].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)) : undefined;
  const all = items.data ?? [];
  const featuredCount = all.filter((i) => i.featured).length;
  const focusCat = focusItem ? all.find((i) => i.id === focusItem)?.categoryId : undefined;
  const current = list?.find((c) => c.id === (selected ?? focusCat)) ?? list?.[0];
  const inCat = current ? all.filter((i) => i.categoryId === current.id) : [];
  const idx = current && list ? list.indexOf(current) : -1;

  const header = (
    <PageHeader
      title="Menu"
      className="mb-5"
      status={r.pureVeg ? <PureVegBadge /> : null}
      meta={
        <>
          <span>
            {all.length} items in {list?.length ?? 0} categories
          </span>
          <span>
            <Icon name="star" size={13} className="mr-1 inline align-[-2px]" />
            {featuredCount} of {MAX_FEATURED} recommended
          </span>
          {r.pureVeg ? (
            <Link to="/restaurant/settings" className="underline underline-offset-2 hover:text-fg">
              Pure-veg kitchen: only vegetarian items
            </Link>
          ) : null}
        </>
      }
      actions={
        <>
          <Button variant="outline" icon="plus" onClick={() => setCatDialog({})}>Add category</Button>
          <Button icon="plus" disabled={!list?.length} onClick={() => setItemDialog({ categoryId: current?.id })}>Add item</Button>
        </>
      }
    />
  );

  let body;
  if (!list || !items.data) {
    body =
      cats.isError || items.isError ? (
        <ErrorState error={cats.error ?? items.error} title="Couldn't load your menu" onRetry={() => void Promise.all([cats.refetch(), items.refetch()])} retrying={cats.isFetching || items.isFetching} />
      ) : (
        <MenuSkeleton />
      );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon="list"
        title="Your menu is empty"
        description="Start with a category such as Starters or Mains, then add your dishes."
        action={<Button icon="plus" onClick={() => setCatDialog({})}>Add your first category</Button>}
      />
    );
  } else {
    body = (
      <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
        <nav aria-label="Categories" className="overflow-hidden rounded-field border border-line bg-card lg:sticky lg:top-0">
          <p className="lbl border-b border-line px-4 py-3">Categories</p>
          <ul className="flex flex-col py-1 max-lg:flex-row max-lg:overflow-x-auto">
            {list.map((c, i) => {
              const count = all.filter((x) => x.categoryId === c.id).length;
              const isCur = c.id === current?.id;
              return (
                <li key={c.id} className="flex shrink-0 items-center gap-1 px-2">
                  <button
                    type="button"
                    aria-current={isCur ? 'true' : undefined}
                    onClick={() => setSelected(c.id)}
                    className={cn(
                      'flex min-h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-item px-2.5 text-left text-sm [@media(pointer:coarse)]:min-h-touch',
                      isCur ? 'bg-fill font-medium text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg',
                    )}
                  >
                    <span className={cn('truncate', !c.active && 'text-fg-3 line-through decoration-fg-3/40')}>{c.name}</span>
                    <span className="font-mono text-[11px] text-fg-3">{count}</span>
                  </button>
                  <span className="flex max-lg:hidden">
                    <IconButton icon="chevron-up" size="xs" label={`Move ${c.name} up`} disabled={i === 0 || move.isPending} onClick={() => move.mutate({ list, index: i, dir: -1 })} />
                    <IconButton icon="chevron-down" size="xs" label={`Move ${c.name} down`} disabled={i === list.length - 1 || move.isPending} onClick={() => move.mutate({ list, index: i, dir: 1 })} />
                  </span>
                </li>
              );
            })}
          </ul>
          <InlineError error={move.error} className="px-4 pb-3" />
        </nav>

        {current ? (
          <section aria-label={current.name} className="overflow-hidden rounded-field border border-line bg-card">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3.5">
              <h2 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal text-fg">
                {current.name}
                <span className="font-mono text-xs font-normal text-fg-3">{inCat.length}</span>
                {!current.active ? <Badge tone="neutral" density="dense">Hidden</Badge> : null}
              </h2>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <span className="lg:hidden">
                  <IconButton icon="chevron-up" size="xs" label={`Move ${current.name} up`} disabled={idx === 0 || move.isPending} onClick={() => move.mutate({ list, index: idx, dir: -1 })} />
                  <IconButton icon="chevron-down" size="xs" label={`Move ${current.name} down`} disabled={idx === list.length - 1 || move.isPending} onClick={() => move.mutate({ list, index: idx, dir: 1 })} />
                </span>
                <span className="mr-1 flex items-center gap-2 text-[13px] text-fg-3">
                  Visible
                  <Toggle checked={current.active} pending={setActive.isPending} onChange={(v) => setActive.mutate({ c: current, active: v })} label={`${current.name} visible to customers`} />
                </span>
                <Button variant="ghost" size="xs" icon="edit" onClick={() => setCatDialog({ category: current })} aria-label={`Edit category ${current.name}`}>Edit</Button>
                <Button variant="ghost" size="xs" icon="trash" onClick={() => setDelCat(current)} aria-label={`Delete category ${current.name}`}>Delete</Button>
              </div>
            </header>
            {inCat.length === 0 ? (
              <EmptyState compact icon="plus" title="No items here yet" action={<Button variant="outline" size="sm" icon="plus" onClick={() => setItemDialog({ categoryId: current.id })}>Add item to {current.name}</Button>} />
            ) : (
              <>
                <ul>
                  {inCat.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      restaurantId={r.id}
                      featuredCount={featuredCount}
                      highlight={i.id === focusItem}
                      onEdit={() => setItemDialog({ item: i })}
                      onDelete={() => setDelItem(i)}
                      onChanged={refresh}
                    />
                  ))}
                </ul>
                <div className="border-t border-line px-4 py-2.5">
                  <Button variant="link" size="sm" icon="plus" onClick={() => setItemDialog({ categoryId: current.id })}>Add item to {current.name}</Button>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {header}
      {body}
      {catDialog ? (
        <CategoryDialog
          key={catDialog.category?.id ?? 'new'}
          open
          onClose={() => setCatDialog(null)}
          restaurantId={r.id}
          category={catDialog.category}
          nextSortOrder={sortOrderAt(cats.data?.length ?? 0)}
          onSaved={() => {
            refresh();
            toast({ title: 'Category saved', tone: 'success' });
          }}
        />
      ) : null}
      {itemDialog && cats.data ? (
        <ItemEditor
          key={itemDialog.item?.id ?? `new-${itemDialog.categoryId ?? ''}`}
          open
          onClose={() => setItemDialog(null)}
          restaurantId={r.id}
          pureVeg={Boolean(r.pureVeg)}
          featuredCount={featuredCount}
          categories={cats.data}
          item={itemDialog.item}
          defaultCategoryId={itemDialog.categoryId}
          onSaved={(saved) => {
            refresh();
            toast({ title: `${saved.name} saved`, tone: 'success' });
          }}
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
          setSelected(null);
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
