/** Step 1: business identity. Creating the restaurant grants the owner role, so the session is refreshed. */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { tryNormalizePhone } from '@thali/contracts';
import { Button, Checkbox, ErrorState, Field, Input, Switch, Textarea, useToast } from '../../../components/ui';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { ApiError, errorMessage, fieldErrors } from '../../../lib/errors';
import { keys, restaurantApi, type OwnerRestaurant, type RestaurantPatch } from '../api';
import { StepFrame, type StepProps } from './StepFrame';

export interface BusinessValues {
  businessName: string;
  name: string;
  description: string;
  cuisines: string[];
  phone: string;
  businessEmail: string;
  /** MKT-4 owner-declared pure-veg kitchen. */
  pureVeg: boolean;
}

export function businessFrom(r: OwnerRestaurant | undefined): BusinessValues {
  return {
    businessName: r?.businessName ?? '',
    name: r?.name ?? '',
    description: r?.description ?? '',
    cuisines: r?.cuisines ?? [],
    phone: r?.phone ?? '',
    businessEmail: r?.businessEmail ?? '',
    pureVeg: Boolean(r?.pureVeg),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBusiness(v: BusinessValues): Record<string, string> {
  const e: Record<string, string> = {};
  if (!v.businessName.trim()) e.businessName = 'Enter the registered business name.';
  if (!v.name.trim()) e.name = 'Enter the restaurant name customers will see.';
  else if (v.name.trim().length > 80) e.name = 'Use 80 characters or fewer.';
  if (!v.description.trim()) e.description = 'Add a short description of your food.';
  else if (v.description.trim().length > 1000) e.description = 'Use 1000 characters or fewer.';
  if (v.cuisines.length === 0) e.cuisines = 'Choose at least one cuisine.';
  else if (v.cuisines.length > 10) e.cuisines = 'Choose up to 10 cuisines.';
  if (!v.phone.trim()) e.phone = 'Enter a phone number customers and riders can reach.';
  else if (!tryNormalizePhone(v.phone)) e.phone = 'Enter a valid Indian mobile number, e.g. 98765 43210.';
  if (!v.businessEmail.trim()) e.businessEmail = 'Enter your business email.';
  else if (!EMAIL.test(v.businessEmail.trim())) e.businessEmail = 'Enter a valid email address.';
  return e;
}

function toPatch(v: BusinessValues, prev?: OwnerRestaurant): RestaurantPatch & { name: string } {
  return {
    ...(v.pureVeg !== Boolean(prev?.pureVeg) ? { pureVeg: v.pureVeg } : {}),
    businessName: v.businessName.trim(),
    name: v.name.trim(),
    description: v.description.trim(),
    cuisines: v.cuisines,
    phone: tryNormalizePhone(v.phone) ?? v.phone.trim(),
    businessEmail: v.businessEmail.trim().toLowerCase(),
  };
}

interface CuisineOption {
  id: string;
  name: string;
  slug: string;
}

export function BusinessStep({ restaurant, onSaved, next }: StepProps) {
  const { refreshUser } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [v, setV] = useState<BusinessValues>(() => businessFrom(restaurant));
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<OwnerRestaurant | null>(null);
  const clientErrors = validateBusiness(v);

  const cuisines = useQuery({
    queryKey: keys.cuisines,
    queryFn: () => api<{ items: CuisineOption[] }>('/cuisines', { auth: false }).then((r) => r.items),
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = toPatch(v, restaurant);
      if (restaurant) return restaurantApi.patch(restaurant.id, body);
      const res = await restaurantApi.create(body);
      setCreated(res.restaurant);
      return res.restaurant;
    },
    onSuccess: async (r) => {
      onSaved(r);
      if (!restaurant) await finishCreate(r);
      else next();
    },
  });

  // The new restaurant grants RESTAURANT_OWNER: refresh the token so the owner endpoints accept us.
  const refresh = useMutation({
    mutationFn: async (r: OwnerRestaurant) => {
      await refreshUser();
      return r;
    },
    onSuccess: (r) => {
      toast({ title: 'Restaurant created', description: 'Now add the location.', tone: 'success' });
      navigate(`/restaurant/onboarding/${r.id}?step=location`, { replace: true });
    },
  });
  const finishCreate = async (r: OwnerRestaurant) => {
    try {
      await refresh.mutateAsync(r);
    } catch {
      /* surfaced below with a retry button */
    }
  };

  const serverErrors = fieldErrors(save.error);
  const err = (k: string) => (showErrors ? clientErrors[k] : undefined) ?? serverErrors[k];
  const set = <K extends keyof BusinessValues>(k: K, val: BusinessValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const knownSlugs = new Set((cuisines.data ?? []).map((c) => c.slug));
  const extra = v.cuisines.filter((s) => !knownSlugs.has(s));
  const options: CuisineOption[] = [...(cuisines.data ?? []), ...extra.map((s) => ({ id: s, name: s, slug: s }))];

  if (created && refresh.isError) {
    return (
      <ErrorState
        title="Restaurant created, but your session didn't refresh"
        message={`${errorMessage(refresh.error)} Your restaurant is saved. Refresh your session to continue.`}
        error={refresh.error}
        onRetry={() => refresh.mutate(created)}
        retrying={refresh.isPending}
      />
    );
  }

  return (
    <StepFrame
      title="Business details"
      description={restaurant ? undefined : 'Tell us about your restaurant or cloud kitchen. You can come back and finish later.'}
      submitting={save.isPending || refresh.isPending}
      submitLabel={restaurant ? 'Save and continue' : 'Create restaurant and continue'}
      error={
        save.error instanceof ApiError && save.error.code === 'PURE_VEG_VIOLATION'
          ? new Error('Your menu still has non-veg items or options. Make them vegetarian (or remove them) before declaring a pure-veg kitchen.')
          : save.isError && Object.keys(serverErrors).length === 0
            ? save.error
            : null
      }
      onSubmit={() => {
        if (Object.keys(clientErrors).length > 0) {
          setShowErrors(true);
          return;
        }
        save.mutate();
      }}
    >
      <Field label="Registered business name" required error={err('businessName')}>
        <Input value={v.businessName} onChange={(e) => set('businessName', e.target.value)} autoComplete="organization" />
      </Field>
      <Field label="Restaurant name" required hint="Shown to customers" error={err('name')}>
        <Input value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />
      </Field>
      <Field label="Description" required error={err('description')}>
        <Textarea value={v.description} onChange={(e) => set('description', e.target.value)} rows={4} maxLength={1000} />
      </Field>

      <fieldset aria-invalid={err('cuisines') ? true : undefined} aria-describedby={err('cuisines') ? 'cuisines-error' : undefined}>
        <legend className="mb-1 text-sm font-medium text-fg">
          Cuisines<span aria-hidden="true" className="ml-0.5 text-bad">*</span>
        </legend>
        {cuisines.isPending ? <p className="text-sm text-fg-3" role="status">Loading cuisines…</p> : null}
        {cuisines.isError ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-bad" role="alert">
            {errorMessage(cuisines.error)}
            <Button variant="outline" size="sm" onClick={() => void cuisines.refetch()}>Retry</Button>
          </div>
        ) : null}
        <div className="grid gap-x-4 sm:grid-cols-2">
          {options.map((c) => (
            <Checkbox
              key={c.slug}
              label={c.name}
              checked={v.cuisines.includes(c.slug)}
              onChange={(e) => set('cuisines', e.target.checked ? [...v.cuisines, c.slug] : v.cuisines.filter((s) => s !== c.slug))}
            />
          ))}
        </div>
        {err('cuisines') ? (
          <p id="cuisines-error" role="alert" className="mt-1 text-sm font-medium text-bad">
            {err('cuisines')}
          </p>
        ) : null}
      </fieldset>

      <Field label="Phone number" required error={err('phone')} hint="Indian mobile number">
        <Input type="tel" inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} />
      </Field>
      <Field
        label="Business email"
        required
        error={err('businessEmail')}
        hint={restaurant?.emailVerified ? 'Changing this email means verifying the new address again.' : "We'll send a verification link when you submit."}
      >
        <Input type="email" inputMode="email" autoComplete="email" value={v.businessEmail} onChange={(e) => set('businessEmail', e.target.value)} />
      </Field>
      <Switch
        label="Pure veg kitchen"
        description="Only vegetarian items and options. Customers see a Pure veg badge and every dish must be veg."
        checked={v.pureVeg}
        onChange={(e) => set('pureVeg', e.target.checked)}
      />
    </StepFrame>
  );
}
