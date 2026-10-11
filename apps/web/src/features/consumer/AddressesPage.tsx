/**
 * Saved addresses (design-spec §7.2; PRD C-7): address cards with Edit / Set default / Delete, an "Add new address"
 * dashed card (max 10), and the address form dialog: label Home / Work / Other, line 1, line 2, landmark,
 * locality (IDN-2), city, pincode, and a map pin for the exact drop point. `AddressForm` is reused by checkout.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import type { GeoPoint } from '@thali/contracts';
import {
  AddAddressCard,
  Badge,
  Button,
  ChoicePills,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FormActions,
  Icon,
  InlineError,
  Input,
  PageHeader,
  Skeleton,
  SkeletonCard,
  useToast,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { api } from '../../lib/api';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { DEFAULT_CENTER } from '../../lib/geo';
import { ADDRESSES_KEY, formatAddress, useAddresses, type SavedAddress } from './api';
import { PageContainer } from './ConsumerLayout';
import { useChosenLocation } from './location';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));
export const MAX_ADDRESSES = 10;

type LabelKind = 'Home' | 'Work' | 'Other';
interface FormState {
  kind: LabelKind;
  other: string;
  line1: string;
  line2: string;
  landmark: string;
  locality: string;
  city: string;
  pincode: string;
  location: GeoPoint | null;
  isDefault: boolean;
}

function kindOf(label: string | null | undefined): LabelKind {
  return label === 'Home' || label === 'Work' ? label : 'Other';
}

function toBody(f: FormState, editing: boolean) {
  const label = f.kind === 'Other' ? f.other.trim() : f.kind;
  return {
    ...(label ? { label } : {}),
    line1: f.line1.trim(),
    ...(f.line2.trim() ? { line2: f.line2.trim() } : editing ? { line2: '' } : {}),
    ...(f.landmark.trim() ? { landmark: f.landmark.trim() } : editing ? { landmark: '' } : {}),
    ...(f.locality.trim() ? { locality: f.locality.trim() } : editing ? { locality: null } : {}),
    city: f.city.trim(),
    pincode: f.pincode.trim(),
    location: f.location!,
    ...(f.isDefault ? { isDefault: true } : {}),
  };
}

export interface AddressFormProps {
  initial?: SavedAddress;
  onSaved: (a: SavedAddress) => void;
  onCancel?: () => void;
}

export function AddressForm({ initial, onSaved, onCancel }: AddressFormProps) {
  const qc = useQueryClient();
  const chosen = useChosenLocation();
  const [f, setF] = useState<FormState>({
    kind: initial ? kindOf(initial.label) : 'Home',
    other: initial && kindOf(initial.label) === 'Other' ? (initial.label ?? '') : '',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    landmark: initial?.landmark ?? '',
    locality: initial?.locality ?? '',
    city: initial?.city ?? 'Bengaluru',
    pincode: initial?.pincode ?? '',
    location: initial?.location ?? (chosen ? { lat: chosen.lat, lng: chosen.lng } : null),
    isDefault: initial?.isDefault ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api<SavedAddress>(`/me/addresses/${initial.id}`, { method: 'PATCH', body: toBody(f, true) })
        : api<SavedAddress>('/me/addresses', { method: 'POST', body: toBody(f, false) }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ADDRESSES_KEY });
      void qc.invalidateQueries({ queryKey: ['me'] });
      onSaved(a);
    },
    onError: (e) => setErrors(fieldErrors(e)),
  });
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.line1.trim()) errs.line1 = 'Enter the house / flat and street';
    if (!f.city.trim()) errs.city = 'Enter the city';
    if (!/^[1-9][0-9]{5}$/.test(f.pincode.trim())) errs.pincode = 'Enter a valid 6-digit pincode';
    if (f.kind === 'Other' && !f.other.trim()) errs.label = 'Name this address (e.g. Mom’s place)';
    if (!f.location) errs.location = 'Pin the exact delivery point on the map';
    setErrors(errs);
    if (Object.keys(errs).length === 0) save.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <ChoicePills
          label="Save as"
          columns={3}
          options={[
            { value: 'Home', label: 'Home' },
            { value: 'Work', label: 'Work' },
            { value: 'Other', label: 'Other' },
          ]}
          value={f.kind}
          onChange={(kind) => setF((s) => ({ ...s, kind: kind as LabelKind }))}
        />
        {f.kind === 'Other' ? (
          <Field label="Name" error={errors.label}>
            <Input value={f.other} maxLength={40} onChange={set('other')} placeholder="e.g. Mom’s place" />
          </Field>
        ) : null}
      </div>
      <Field label="House / flat, street" required error={errors.line1}>
        <Input value={f.line1} maxLength={200} autoComplete="address-line1" onChange={set('line1')} />
      </Field>
      <Field label="Area / building" optional error={errors.line2}>
        <Input value={f.line2} maxLength={200} autoComplete="address-line2" onChange={set('line2')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Landmark" optional error={errors.landmark}>
          <Input value={f.landmark} maxLength={120} onChange={set('landmark')} />
        </Field>
        <Field label="Locality" optional hint="e.g. Indiranagar" error={errors.locality}>
          <Input value={f.locality} maxLength={60} onChange={set('locality')} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" required error={errors.city}>
          <Input value={f.city} maxLength={80} autoComplete="address-level2" onChange={set('city')} />
        </Field>
        <Field label="Pincode" required error={errors.pincode}>
          <Input value={f.pincode} inputMode="numeric" maxLength={6} autoComplete="postal-code" onChange={set('pincode')} />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-fg">
          Delivery point <span className="text-bad">*</span>
        </p>
        <p className="text-[13px] text-fg-3">Tap the map at your building entrance so the partner finds you.</p>
        <div className="overflow-hidden rounded-field border border-line">
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <MapView center={f.location ?? DEFAULT_CENTER} picked={f.location} onPick={(p) => setF((s) => ({ ...s, location: p }))} ariaLabel="Pin the delivery point" className="h-56" />
          </Suspense>
        </div>
        {errors.location ? (
          <p role="alert" className="text-[13px] font-medium text-bad">
            {errors.location}
          </p>
        ) : null}
      </div>
      <label className="flex min-h-touch items-center gap-2.5 text-sm text-fg">
        <input type="checkbox" className="size-[18px] accent-[var(--pri)]" checked={f.isDefault} onChange={(e) => setF((s) => ({ ...s, isDefault: e.target.checked }))} />
        Make this my default address
      </label>
      <InlineError error={save.error && Object.keys(fieldErrors(save.error)).length === 0 ? save.error : null} />
      <FormActions>
        {onCancel ? (
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={save.isPending}>
          Save address
        </Button>
      </FormActions>
    </form>
  );
}

function SavedAddressCard({ a, onEdit }: { a: SavedAddress; onEdit: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const makeDefault = useMutation({
    mutationFn: () => api(`/me/addresses/${a.id}`, { method: 'PATCH', body: { isDefault: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADDRESSES_KEY }),
    onError: (e) => toast({ title: "Couldn't update address", description: errorMessage(e), tone: 'danger' }),
  });
  return (
    <li className="flex list-none flex-col gap-3 rounded-field border border-line bg-card px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-item bg-fill text-fg-2">
          <Icon name={a.label === 'Home' ? 'home' : a.label === 'Work' ? 'store' : 'location'} size={17} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex items-center gap-2 text-[14.5px] font-semibold">
            {a.label || 'Address'}
            {a.isDefault ? <span className="rounded-tag bg-fill px-1.5 py-0.5 font-mono text-[10px] font-normal text-fg-3">DEFAULT</span> : null}
          </p>
          <p className="text-[13px] leading-[1.45] text-fg-3">
            {formatAddress(a)}
            {a.landmark ? ` · near ${a.landmark}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="xs" variant="ghost" icon="edit" onClick={onEdit}>
          Edit
        </Button>
        {!a.isDefault ? (
          <Button size="xs" variant="ghost" onClick={() => makeDefault.mutate()} loading={makeDefault.isPending}>
            Set default
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" icon="trash" onClick={() => setConfirm(true)} aria-label={`Delete ${a.label || 'address'}`}>
          Delete
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this address?"
        description={formatAddress(a)}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={async () => {
          await api(`/me/addresses/${a.id}`, { method: 'DELETE' });
          await qc.invalidateQueries({ queryKey: ADDRESSES_KEY });
        }}
      />
    </li>
  );
}

function AddressesContent() {
  const addresses = useAddresses();
  const [editing, setEditing] = useState<SavedAddress | 'new' | null>(null);
  const count = addresses.data?.length ?? 0;
  return (
    <>
      {addresses.isPending ? (
        <div role="status" aria-busy="true" className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-3">
          <span className="sr-only">Loading addresses…</span>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : addresses.isError ? (
        <ErrorState error={addresses.error} title="Couldn't load your addresses" onRetry={() => void addresses.refetch()} />
      ) : (
        <>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-3">
            {addresses.data.map((a) => (
              <SavedAddressCard key={a.id} a={a} onEdit={() => setEditing(a)} />
            ))}
            <li className="flex list-none">
              {count >= MAX_ADDRESSES ? (
                <p className="flex min-h-[76px] w-full items-center justify-center rounded-field border border-dashed border-line-2 px-4 text-center text-sm text-fg-3">
                  Address limit reached ({MAX_ADDRESSES}). Delete one to add another.
                </p>
              ) : (
                <AddAddressCard onClick={() => setEditing('new')} className="w-full" />
              )}
            </li>
          </ul>
          {count === 0 ? <p className="mt-3 text-sm text-fg-3">Save your home or work address for faster checkout.</p> : null}
          <p className="mt-4 text-[13px] text-fg-3">
            <Badge tone="neu">{count} of {MAX_ADDRESSES}</Badge> saved
          </p>
        </>
      )}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add new address' : 'Edit address'} size="lg">
        {editing !== null ? <AddressForm initial={editing === 'new' ? undefined : editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} /> : null}
      </Dialog>
    </>
  );
}

export default function AddressesPage() {
  return (
    <PageContainer>
      <PageHeader size="page" title="Saved addresses" back={{ to: '/account', label: 'Account' }} />
      <RequireAuth signInMessage="Sign in to manage your saved addresses.">
        <AddressesContent />
      </RequireAuth>
    </PageContainer>
  );
}
