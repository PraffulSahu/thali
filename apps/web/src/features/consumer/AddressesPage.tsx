/**
 * Saved addresses (PRD C-7): list, add (with map pin for the exact drop point), edit, delete, make default.
 * `AddressForm` is reused by checkout ("Add a new address").
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import type { GeoPoint } from '@thali/contracts';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Field,
  FormActions,
  InlineError,
  Input,
  PageHeader,
  QueryState,
  Skeleton,
  useToast,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { api } from '../../lib/api';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { DEFAULT_CENTER } from '../../lib/geo';
import { ADDRESSES_KEY, formatAddress, useAddresses, type SavedAddress } from './api';
import { useChosenLocation } from './location';

const MapView = lazy(() => import('../../components/ui/Map').then((m) => ({ default: m.MapView })));

interface FormState {
  label: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  pincode: string;
  location: GeoPoint | null;
  isDefault: boolean;
}

function toBody(f: FormState) {
  return {
    ...(f.label.trim() ? { label: f.label.trim() } : {}),
    line1: f.line1.trim(),
    ...(f.line2.trim() ? { line2: f.line2.trim() } : {}),
    ...(f.landmark.trim() ? { landmark: f.landmark.trim() } : {}),
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
    label: initial?.label ?? '',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    landmark: initial?.landmark ?? '',
    city: initial?.city ?? '',
    pincode: initial?.pincode ?? '',
    location: initial?.location ?? (chosen ? { lat: chosen.lat, lng: chosen.lng } : null),
    isDefault: initial?.isDefault ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api<SavedAddress>(`/me/addresses/${initial.id}`, { method: 'PATCH', body: toBody(f) })
        : api<SavedAddress>('/me/addresses', { method: 'POST', body: toBody(f) }),
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
    if (!f.line1.trim()) errs.line1 = 'Enter the house / street';
    if (!f.city.trim()) errs.city = 'Enter the city';
    if (!/^[1-9][0-9]{5}$/.test(f.pincode.trim())) errs.pincode = 'Enter a valid 6-digit pincode';
    if (!f.location) errs.location = 'Pin the exact delivery point on the map';
    setErrors(errs);
    if (Object.keys(errs).length === 0) save.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Label" optional hint="E.g. Home, Work" error={errors.label}>
          <Input value={f.label} maxLength={40} onChange={set('label')} />
        </Field>
        <Field label="Pincode" required error={errors.pincode}>
          <Input value={f.pincode} inputMode="numeric" maxLength={6} autoComplete="postal-code" onChange={set('pincode')} />
        </Field>
      </div>
      <Field label="House / flat, street" required error={errors.line1}>
        <Input value={f.line1} maxLength={200} autoComplete="address-line1" onChange={set('line1')} />
      </Field>
      <Field label="Area" optional error={errors.line2}>
        <Input value={f.line2} maxLength={200} autoComplete="address-line2" onChange={set('line2')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Landmark" optional error={errors.landmark}>
          <Input value={f.landmark} maxLength={120} onChange={set('landmark')} />
        </Field>
        <Field label="City" required error={errors.city}>
          <Input value={f.city} maxLength={80} autoComplete="address-level2" onChange={set('city')} />
        </Field>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-800">
          Delivery point <span className="text-danger-700">*</span>
        </p>
        <p className="text-sm text-slate-600">Tap the map at your building entrance so the partner finds you.</p>
        <Suspense fallback={<Skeleton className="h-56 w-full" />}>
          <MapView
            center={f.location ?? DEFAULT_CENTER}
            picked={f.location}
            onPick={(p) => setF((s) => ({ ...s, location: p }))}
            ariaLabel="Pin the delivery point"
            className="h-56"
          />
        </Suspense>
        {errors.location ? (
          <p role="alert" className="text-sm font-medium text-danger-700">
            {errors.location}
          </p>
        ) : null}
      </div>
      <label className="flex min-h-touch items-center gap-2 text-sm text-slate-800">
        <input type="checkbox" className="size-5 accent-brand-600" checked={f.isDefault} onChange={(e) => setF((s) => ({ ...s, isDefault: e.target.checked }))} />
        Make this my default address
      </label>
      <InlineError error={save.error && Object.keys(fieldErrors(save.error)).length === 0 ? save.error : null} />
      <FormActions>
        {onCancel ? (
          <Button variant="secondary" type="button" onClick={onCancel}>
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

function AddressCard({ a, onEdit }: { a: SavedAddress; onEdit: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const makeDefault = useMutation({
    mutationFn: () => api(`/me/addresses/${a.id}`, { method: 'PATCH', body: { isDefault: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADDRESSES_KEY }),
    onError: (e) => toast({ title: "Couldn't update address", description: errorMessage(e), tone: 'danger' }),
  });
  return (
    <Card as="li">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">
            {a.label || 'Address'} {a.isDefault ? <Badge tone="brand">Default</Badge> : null}
          </p>
          <p className="text-sm text-slate-600">{formatAddress(a)}</p>
          {a.landmark ? <p className="text-sm text-slate-600">Near {a.landmark}</p> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon="edit" onClick={onEdit}>
          Edit
        </Button>
        {!a.isDefault ? (
          <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate()} loading={makeDefault.isPending}>
            Make default
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirm(true)}>
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
    </Card>
  );
}

function AddressesContent() {
  const addresses = useAddresses();
  const [editing, setEditing] = useState<SavedAddress | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Saved addresses"
        back={{ to: '/account', label: 'Account' }}
        actions={
          <Button icon="plus" onClick={() => setEditing('new')}>
            Add address
          </Button>
        }
      />
      <QueryState
        query={addresses}
        isEmpty={(l) => l.length === 0}
        empty={{ icon: 'location', title: 'No saved addresses', description: 'Save your home or work address for faster checkout.', action: <Button onClick={() => setEditing('new')}>Add address</Button> }}
      >
        {(list) => (
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.map((a) => (
              <AddressCard key={a.id} a={a} onEdit={() => setEditing(a)} />
            ))}
          </ul>
        )}
      </QueryState>
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add address' : 'Edit address'} size="lg">
        {editing !== null ? (
          <AddressForm initial={editing === 'new' ? undefined : editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        ) : null}
      </Dialog>
    </>
  );
}

export default function AddressesPage() {
  return (
    <RequireAuth signInMessage="Sign in to manage your saved addresses.">
      <AddressesContent />
    </RequireAuth>
  );
}
