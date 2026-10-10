/** `/admin/catalog`: coupons, banners, cuisines, membership plans and service areas (with fee rules). */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PageHeader } from '../../components/ui/PageHeader';
import { Price } from '../../components/ui/Price';
import { Tabs } from '../../components/ui/Tabs';
import { formatBps, formatDateTime, formatDistanceKm } from '../../lib/format';
import { deleteCatalog, listCatalog, qk, type Banner, type CatalogKind, type Coupon, type Cuisine, type MembershipPlan, type ServiceArea } from './api';
import BannerEditor from './editors/BannerEditor';
import CouponEditor from './editors/CouponEditor';
import CuisineEditor from './editors/CuisineEditor';
import PlanEditor from './editors/PlanEditor';
import ServiceAreaEditor from './editors/ServiceAreaEditor';
import { DemoBadge, useAdminMutation } from './shared';

interface SectionProps<T extends { id: string }> {
  kind: CatalogKind;
  noun: string;
  nounPlural: string;
  columns: Column<T>[];
  labelOf: (item: T) => string;
  Editor: (p: { open: boolean; item: T | null; onClose: () => void }) => ReactNode;
  emptyHint: string;
  note?: ReactNode;
}

function CatalogSection<T extends { id: string }>({ kind, noun, nounPlural, columns, labelOf, Editor, emptyHint, note }: SectionProps<T>) {
  const query = useQuery({ queryKey: qk.catalog(kind), queryFn: () => listCatalog<T>(kind) });
  const [editing, setEditing] = useState<T | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<T | null>(null);
  const del = useAdminMutation((id: string) => deleteCatalog(kind, id), { success: `${noun} deleted`, invalidate: [['admin', 'catalog', kind]] });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{note}</p>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add {noun.toLowerCase()}
        </Button>
      </div>
      <DataTable
        caption={nounPlural}
        columns={columns}
        rows={query.data?.items}
        getRowId={(r) => r.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'list', title: `No ${nounPlural.toLowerCase()} yet`, description: emptyHint, action: <Button onClick={() => setAdding(true)}>Add {noun.toLowerCase()}</Button> }}
        rowActions={(r) => (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" icon="edit" onClick={() => setEditing(r)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(r)}>
              Delete
            </Button>
          </div>
        )}
      />
      <Editor open={adding || editing !== null} item={editing} onClose={() => { setAdding(false); setEditing(null); }} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting ? labelOf(deleting) : noun.toLowerCase()}?`}
        description="This cannot be undone. To hide it temporarily, edit it and switch off Active instead."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => del.mutateAsync(deleting!.id)}
      />
    </div>
  );
}

const activeBadge = (a: boolean) => (a ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>);

const couponCols: Column<Coupon>[] = [
  { key: 'code', header: 'Code', cell: (c) => <span className="font-mono font-semibold">{c.code}</span>, primary: true },
  { key: 'value', header: 'Discount', cell: (c) => (c.type === 'FLAT' ? <Price paise={c.valuePaise ?? 0} /> : `${formatBps(c.valueBps ?? 0)} off${c.maxDiscountPaise ? ` (max ₹${Math.floor(c.maxDiscountPaise / 100)})` : ''}`), secondary: true },
  { key: 'min', header: 'Min order', cell: (c) => <Price paise={c.minOrderPaise ?? 0} freeLabel="None" />, hideOnMobile: true },
  { key: 'valid', header: 'Valid', cell: (c) => `${formatDateTime(c.validFrom)} to ${formatDateTime(c.validTo)}`, hideOnMobile: true },
  { key: 'used', header: 'Used', cell: (c) => `${c.usedCount ?? 0}${c.totalLimit ? ` / ${c.totalLimit}` : ''}`, hideOnMobile: true },
  { key: 'active', header: 'Status', cell: (c) => activeBadge(c.active) },
];
const bannerCols: Column<Banner>[] = [
  { key: 'title', header: 'Title', cell: (b) => <span className="flex items-center gap-2">{b.title}{b.isDemo ? <DemoBadge /> : null}</span>, primary: true },
  { key: 'link', header: 'Links to', cell: (b) => `${b.linkType.toLowerCase()}: ${b.linkValue}`, secondary: true },
  { key: 'window', header: 'Shows', cell: (b) => `${formatDateTime(b.activeFrom)} to ${formatDateTime(b.activeTo)}`, hideOnMobile: true },
  { key: 'active', header: 'Status', cell: (b) => activeBadge(b.active) },
];
const cuisineCols: Column<Cuisine>[] = [
  { key: 'name', header: 'Cuisine', cell: (c) => c.name, primary: true },
  { key: 'slug', header: 'Slug', cell: (c) => c.slug, secondary: true },
  { key: 'order', header: 'Sort order', cell: (c) => c.sortOrder, align: 'right', hideOnMobile: true },
  { key: 'active', header: 'Status', cell: (c) => activeBadge(c.active) },
];
const planCols: Column<MembershipPlan>[] = [
  { key: 'name', header: 'Plan', cell: (p) => p.name, primary: true },
  { key: 'price', header: 'Price', cell: (p) => <Price paise={p.pricePaise} />, secondary: true },
  { key: 'days', header: 'Duration', cell: (p) => `${p.durationDays} days`, hideOnMobile: true },
  {
    key: 'benefits',
    header: 'Benefits',
    cell: (p) => [p.benefits.freeDeliveriesPerPeriod ? `${p.benefits.freeDeliveriesPerPeriod} free deliveries` : '', p.benefits.extraDiscountBps ? `${formatBps(p.benefits.extraDiscountBps)} extra off` : ''].filter(Boolean).join(', ') || '-',
    hideOnMobile: true,
  },
  { key: 'active', header: 'Status', cell: (p) => activeBadge(p.active) },
];
const areaCols: Column<ServiceArea>[] = [
  { key: 'name', header: 'Area', cell: (a) => a.name, primary: true },
  { key: 'fee', header: 'Delivery fee', cell: (a) => <span><Price paise={a.deliveryFee.basePaise} /> up to {formatDistanceKm(a.deliveryFee.baseKm)}, then <Price paise={a.deliveryFee.perKmPaise} />/km (max <Price paise={a.deliveryFee.maxPaise} />)</span>, secondary: true },
  { key: 'min', header: 'Min order', cell: (a) => <Price paise={a.minOrderPaise} freeLabel="None" />, hideOnMobile: true },
  { key: 'corners', header: 'Corners', cell: (a) => Math.max(0, (a.polygon.coordinates[0]?.length ?? 1) - 1), align: 'right', hideOnMobile: true },
  { key: 'active', header: 'Status', cell: (a) => activeBadge(a.active) },
];

export default function CatalogPage() {
  return (
    <>
      <PageHeader title="Catalog" description="Promotions, home-screen content, cuisines, memberships and where Thali delivers." />
      <Tabs
        label="Catalog sections"
        tabs={[
          { id: 'coupons', label: 'Coupons', content: <CatalogSection<Coupon> kind="coupons" noun="Coupon" nounPlural="Coupons" columns={couponCols} labelOf={(c) => c.code} Editor={CouponEditor} emptyHint="Create a coupon customers can apply at checkout." /> },
          { id: 'banners', label: 'Banners', content: <CatalogSection<Banner> kind="banners" noun="Banner" nounPlural="Banners" columns={bannerCols} labelOf={(b) => b.title} Editor={BannerEditor} emptyHint="Banners appear at the top of the home screen." /> },
          { id: 'cuisines', label: 'Cuisines', content: <CatalogSection<Cuisine> kind="cuisines" noun="Cuisine" nounPlural="Cuisines" columns={cuisineCols} labelOf={(c) => c.name} Editor={CuisineEditor} emptyHint="Cuisines are used for filters and restaurant tags." /> },
          { id: 'plans', label: 'Memberships', content: <CatalogSection<MembershipPlan> kind="plans" noun="Plan" nounPlural="Membership plans" columns={planCols} labelOf={(p) => p.name} Editor={PlanEditor} emptyHint="Plans give members free delivery and extra discounts." /> },
          { id: 'areas', label: 'Service areas', content: <CatalogSection<ServiceArea> kind="service-areas" noun="Service area" nounPlural="Service areas" columns={areaCols} labelOf={(a) => a.name} Editor={ServiceAreaEditor} emptyHint="Draw an area on the map and set its delivery fees. Customers outside every active area can't order." note="Delivery fee = base fee up to the base distance, then a per-km charge, capped at the maximum." /> },
        ]}
      />
    </>
  );
}
