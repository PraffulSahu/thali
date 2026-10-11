/**
 * Store settings (design-spec §7.3) as section cards: Taking orders (pause 15/30/60/custom, resume), Opening hours
 * (weekly editor, overnight), Profile (name, description, phone, locality MKT-5, pure veg MKT-4 with its 422),
 * Delivery & kitchen (radius, packaging fee, average prep), Settlement (masked "Account ending 9012" + Update),
 * Sessions (sign out of all devices). Times are India Standard Time.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { tryNormalizePhone } from '@thali/contracts';
import {
  Button, ConfirmDialog, Field, FormActions, InlineError, Input, PageHeader, Price, SectionCard, Switch, Textarea, useToast,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { ApiError, fieldErrors } from '../../lib/errors';
import { formatDuration, formatTime } from '../../lib/format';
import { HoursEditor } from './HoursEditor';
import { cacheRestaurant, keys, menuApi, paiseToRupees, restaurantApi, rupeesToPaise, type OwnerRestaurant } from './api';
import { slotsFromWeek, validateWeek, weekFromSlots, type WeekState } from './hours';
import { PauseChoices, usePauseActions, usePaused } from './PauseControl';
import { useCurrentRestaurant } from './RestaurantContext';
import { validateSettlement, type SettlementValues } from './steps/SettlementStep';
import { useCountdown } from '../../components/ui/Countdown';
import { useNavigate } from 'react-router';

export { PAUSE_OPTIONS } from './PauseControl';

function Card({ title, meta, children, id }: { title: string; meta?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <SectionCard title={title} meta={meta} className="scroll-mt-4" bodyClassName="px-4 py-4">
      <div id={id} className="flex flex-col gap-4">
        {children}
      </div>
    </SectionCard>
  );
}

function SaveRow({ dirty, pending, label, show, invalid }: { dirty: boolean; pending: boolean; label: string; show?: boolean; invalid?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" loading={pending} disabled={!dirty}>
        {label}
      </Button>
      {!dirty ? <span className="text-[13px] text-fg-3">No changes to save.</span> : null}
      {dirty && show && invalid ? (
        <span role="alert" className="text-[13px] font-medium text-bad">
          Fix the highlighted fields to save.
        </span>
      ) : null}
    </div>
  );
}

function PauseCard({ r }: { r: OwnerRestaurant }) {
  const paused = usePaused(r);
  const left = useCountdown(r.pausedUntil);
  const { pause, resume } = usePauseActions(r);
  const approved = r.status === 'APPROVED';
  return (
    <Card title="Taking orders" meta={paused ? 'Paused' : approved ? 'Open within your hours' : 'Not live yet'}>
      <div aria-live="polite" className="flex flex-col gap-3">
        {paused ? (
          <>
            <p className="text-sm text-fg-2">
              Paused until <strong className="font-medium text-fg">{formatTime(r.pausedUntil)}</strong> ({formatDuration(left ?? 0)} left). Customers see &ldquo;Temporarily not accepting orders&rdquo;.
            </p>
            <div>
              <Button onClick={() => resume.mutate()} loading={resume.isPending}>
                Resume ordering now
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-3">
              {approved ? 'Need a break? New orders stop while paused; orders you already accepted carry on.' : 'You can pause ordering once your restaurant is approved.'}
            </p>
            <div className="max-w-md">
              <PauseChoices onPause={(m) => pause.mutate(m)} pending={pause.isPending} disabled={!approved} error={pause.error} />
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function HoursCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [week, setWeek] = useState<WeekState>(() => weekFromSlots(r.hours));
  const [show, setShow] = useState(false);
  const check = validateWeek(week);
  const next = slotsFromWeek(week);
  const dirty = JSON.stringify(next) !== JSON.stringify(slotsFromWeek(weekFromSlots(r.hours)));
  const save = useMutation({
    mutationFn: () => restaurantApi.setHours(r.id, next),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      void qc.invalidateQueries({ queryKey: keys.dashboard(r.id) });
      setShow(false);
      toast({ title: 'Opening hours saved', tone: 'success' });
    },
  });
  return (
    <Card title="Opening hours" meta="India Standard Time">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!check.valid) return setShow(true);
          save.mutate();
        }}
      >
        <p className="text-[13px] text-fg-3">A closing time earlier than the opening time runs past midnight (for example 18:00 to 02:00).</p>
        <HoursEditor value={week} onChange={setWeek} errors={show ? check.errors : {}} />
        <InlineError error={save.error} />
        <SaveRow dirty={dirty} pending={save.isPending} label="Save hours" show={show} invalid={!check.valid} />
      </form>
    </Card>
  );
}

function ProfileCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(r.name);
  const [description, setDescription] = useState(r.description ?? '');
  const [phone, setPhone] = useState(r.phone ?? '');
  const [locality, setLocality] = useState(r.address?.locality ?? '');
  const [pureVeg, setPureVeg] = useState(Boolean(r.pureVeg));
  const [show, setShow] = useState(false);
  const items = useQuery({ queryKey: keys.items(r.id), queryFn: () => menuApi.items(r.id), enabled: pureVeg && !r.pureVeg, staleTime: 60_000 });

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Enter the restaurant name customers see.';
  else if (name.trim().length > 80) errors.name = 'Use 80 characters or fewer.';
  if (!description.trim()) errors.description = 'Add a short description of your food.';
  else if (description.trim().length > 1000) errors.description = 'Use 1000 characters or fewer.';
  if (!phone.trim() || !tryNormalizePhone(phone)) errors.phone = 'Enter a valid Indian mobile number, e.g. 98765 43210.';
  if (locality.trim().length > 60) errors.locality = 'Use 60 characters or fewer.';
  const normPhone = tryNormalizePhone(phone) ?? phone.trim();
  const changed = {
    name: name.trim() !== r.name,
    description: description.trim() !== (r.description ?? ''),
    phone: normPhone !== (r.phone ?? ''),
    locality: locality.trim() !== (r.address?.locality ?? ''),
    pureVeg: pureVeg !== Boolean(r.pureVeg),
  };
  const dirty = Object.values(changed).some(Boolean);

  const save = useMutation({
    mutationFn: () =>
      restaurantApi.patch(r.id, {
        ...(changed.name ? { name: name.trim() } : {}),
        ...(changed.description ? { description: description.trim() } : {}),
        ...(changed.phone ? { phone: normPhone } : {}),
        ...(changed.locality && r.address
          ? { address: { line1: r.address.line1, ...(r.address.line2 ? { line2: r.address.line2 } : {}), ...(locality.trim() ? { locality: locality.trim() } : {}), city: r.address.city, pincode: r.address.pincode } }
          : {}),
        ...(changed.pureVeg ? { pureVeg } : {}),
      }),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      setShow(false);
      toast({ title: 'Profile saved', tone: 'success' });
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string) => (show ? errors[k] : undefined) ?? server[k];

  // 422 PURE_VEG_VIOLATION {itemIds, optionIds}: name the non-veg items that block it
  let violation: string | null = null;
  if (save.error instanceof ApiError && save.error.code === 'PURE_VEG_VIOLATION') {
    const d = (save.error.details ?? {}) as { itemIds?: string[]; optionIds?: string[] };
    const ids = new Set([...(d.itemIds ?? [])]);
    const optIds = new Set(d.optionIds ?? []);
    const names = (items.data ?? [])
      .filter((i) => ids.has(i.id) || i.customizationGroups.some((g) => g.options.some((o) => o.id && optIds.has(o.id))))
      .map((i) => i.name);
    violation = `Your menu still has non-veg ${names.length ? `items or options: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}` : 'items or options'}. Make them vegetarian or remove them, then turn on Pure veg.`;
  }

  return (
    <Card title="Profile" meta="Shown to customers">
      <form
        noValidate
        className="grid gap-4 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(errors).length) return setShow(true);
          save.mutate();
        }}
      >
        <Field label="Restaurant name" required error={err('name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Phone number" required error={err('phone')} hint="Riders and support can reach you here">
          <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Description" error={err('description')} className="lg:col-span-2">
          <Textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Locality"
          error={err('locality') ?? server['address.locality']}
          hint={r.address ? `Shown next to your name, e.g. "Indiranagar". Address: ${r.address.line1}, ${r.address.city} ${r.address.pincode}` : 'Add your address in onboarding first.'}
        >
          <Input value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={60} disabled={!r.address} placeholder="e.g. Indiranagar" />
        </Field>
        <div className="lg:pt-6">
          <Switch
            label="Pure veg kitchen"
            description="Only vegetarian items and options. Customers see a Pure veg badge."
            checked={pureVeg}
            onChange={(e) => setPureVeg(e.target.checked)}
          />
        </div>
        {violation ? (
          <p role="alert" className="rounded-item bg-bad-bg px-3 py-2 text-[13px] text-bad lg:col-span-2">
            {violation}
          </p>
        ) : save.isError && Object.keys(server).length === 0 ? (
          <InlineError error={save.error} className="lg:col-span-2" />
        ) : null}
        <div className="lg:col-span-2">
          <SaveRow dirty={dirty} pending={save.isPending} label="Save profile" show={show} invalid={Object.keys(errors).length > 0} />
        </div>
      </form>
    </Card>
  );
}

function KitchenCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [prep, setPrep] = useState(String(r.avgPrepMinutes));
  const [fee, setFee] = useState(paiseToRupees(r.packagingFeePaise));
  const [radius, setRadius] = useState(String(r.deliveryRadiusKm));
  const [show, setShow] = useState(false);
  const errors: Record<string, string> = {};
  if (!/^\d+$/.test(prep) || Number(prep) < 5 || Number(prep) > 120) errors.prep = 'Enter whole minutes between 5 and 120.';
  if (rupeesToPaise(fee) === null) errors.fee = 'Enter an amount like 10 or 12.50 (0 for none).';
  const rad = Number(radius);
  if (!radius.trim() || !Number.isFinite(rad) || rad < 0.5 || rad > 15) errors.radius = 'Enter a radius between 0.5 and 15 km.';
  const dirty = prep !== String(r.avgPrepMinutes) || rupeesToPaise(fee) !== r.packagingFeePaise || rad !== r.deliveryRadiusKm;
  const save = useMutation({
    mutationFn: () => restaurantApi.patch(r.id, { avgPrepMinutes: Number(prep), packagingFeePaise: rupeesToPaise(fee)!, deliveryRadiusKm: rad }),
    onSuccess: (u) => {
      cacheRestaurant(qc, u);
      setShow(false);
      toast({ title: 'Kitchen settings saved', tone: 'success' });
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: string, sk: string) => (show ? errors[k] : undefined) ?? server[sk];
  return (
    <Card title="Delivery and kitchen" meta="Used for estimates and as the default prep time">
      <form
        className="grid gap-4 sm:grid-cols-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(errors).length) return setShow(true);
          save.mutate();
        }}
      >
        <Field label="Average prep time" error={err('prep', 'avgPrepMinutes')}>
          <Input type="number" inputMode="numeric" min={5} max={120} suffix="min" value={prep} onChange={(e) => setPrep(e.target.value)} />
        </Field>
        <Field label="Packaging fee per order" error={err('fee', 'packagingFeePaise')} hint={rupeesToPaise(fee) ? <>Customers pay <Price paise={rupeesToPaise(fee)!} size="sm" /></> : undefined}>
          <Input inputMode="decimal" prefix="₹" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <Field label="Delivery radius" error={err('radius', 'deliveryRadiusKm')}>
          <Input type="number" inputMode="decimal" step="0.5" min={0.5} max={15} suffix="km" value={radius} onChange={(e) => setRadius(e.target.value)} />
        </Field>
        {save.isError && Object.keys(server).length === 0 ? <InlineError error={save.error} className="sm:col-span-3" /> : null}
        <div className="sm:col-span-3">
          <SaveRow dirty={dirty} pending={save.isPending} label="Save settings" />
        </div>
      </form>
    </Card>
  );
}

function SettlementCard({ r }: { r: OwnerRestaurant }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const existing = r.settlement;
  const [editing, setEditing] = useState(false);
  const blank = (): SettlementValues => ({ accountHolder: existing?.accountHolder ?? '', accountNumber: '', confirmNumber: '', ifsc: existing?.ifsc ?? '' });
  const [v, setV] = useState<SettlementValues>(blank);
  const [show, setShow] = useState(false);
  const errors = validateSettlement(v);
  const save = useMutation({
    mutationFn: () => restaurantApi.setSettlement(r.id, { accountHolder: v.accountHolder.trim(), accountNumber: v.accountNumber, ifsc: v.ifsc }),
    onSuccess: (s) => {
      cacheRestaurant(qc, { ...r, settlement: s });
      setEditing(false);
      setShow(false);
      setV(blank());
      toast({ title: 'Settlement account updated', description: `Payouts go to the account ending ${s.last4}.`, tone: 'success' });
    },
  });
  const server = fieldErrors(save.error);
  const err = (k: keyof SettlementValues) => (show ? errors[k] : undefined) ?? server[k];
  const set = (k: keyof SettlementValues, val: string) => setV((p) => ({ ...p, [k]: val }));
  return (
    <Card title="Settlement" meta="Where payouts are sent">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {existing ? (
            <div>
              <p className="text-sm font-medium text-fg">{existing.accountHolder}</p>
              <p className="font-mono text-[13px] text-fg-3">
                Account ending {existing.last4} · IFSC {existing.ifsc}
              </p>
            </div>
          ) : (
            <p className="text-sm text-fg-3">No bank account yet. Add one so Thali can pay you.</p>
          )}
          <Button variant="outline" onClick={() => setEditing(true)}>
            {existing ? 'Update' : 'Add bank account'}
          </Button>
        </div>
      ) : (
        <form
          noValidate
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (Object.keys(errors).length) return setShow(true);
            save.mutate();
          }}
        >
          <p className="text-[13px] text-fg-3 sm:col-span-2">The account number is stored encrypted; only its last 4 digits are shown again.</p>
          <Field label="Account holder name" required error={err('accountHolder')}>
            <Input value={v.accountHolder} onChange={(e) => set('accountHolder', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="IFSC code" required error={err('ifsc')} hint="11 characters, e.g. HDFC0001234">
            <Input autoComplete="off" value={v.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={11} className="font-mono" />
          </Field>
          <Field label="Account number" required error={err('accountNumber')}>
            <Input inputMode="numeric" autoComplete="off" value={v.accountNumber} onChange={(e) => set('accountNumber', e.target.value.replace(/\D/g, ''))} maxLength={18} className="font-mono" />
          </Field>
          <Field label="Confirm account number" required error={err('confirmNumber')}>
            <Input inputMode="numeric" autoComplete="off" value={v.confirmNumber} onChange={(e) => set('confirmNumber', e.target.value.replace(/\D/g, ''))} maxLength={18} className="font-mono" />
          </Field>
          {save.isError && Object.keys(server).length === 0 ? <InlineError error={save.error} className="sm:col-span-2" /> : null}
          <FormActions className="sm:col-span-2">
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setShow(false);
                setV(blank());
              }}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save bank account
            </Button>
          </FormActions>
        </form>
      )}
    </Card>
  );
}

function SessionsCard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  return (
    <Card title="Sessions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-3">Lost a tablet at the counter? Sign out everywhere, including this device.</p>
        <Button variant="danger-outline" onClick={() => setConfirm(true)}>
          Sign out of all devices
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="danger"
        title="Sign out of all devices?"
        description="Every device signed in to this account, including this one, has to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          await auth.signOutEverywhere();
          navigate('/signin?role=restaurant&next=/restaurant');
        }}
      />
    </Card>
  );
}

export default function StoreSettingsPage() {
  const r = useCurrentRestaurant();
  return (
    <>
      <PageHeader title="Store settings" className="mb-5" meta={<span>{r.name} · times in IST</span>} />
      <div className="grid items-start gap-3.5 xl:grid-cols-2">
        <div className="flex flex-col gap-3.5">
          <PauseCard r={r} />
          <ProfileCard r={r} />
          <KitchenCard r={r} />
          <SettlementCard r={r} />
          <SessionsCard />
        </div>
        <HoursCard r={r} />
      </div>
    </>
  );
}
