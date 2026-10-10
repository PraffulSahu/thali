/**
 * Delivery partner onboarding (`/partner/onboarding`, sign-in only; DELIVERY_PARTNER is granted by creating the profile):
 *   1. details   POST /partner/profile (create) | PATCH /partner/profile   -> auth.refreshUser() after create
 *   2. documents POST /partner/uploads (presign) -> PUT to storage -> POST /partner/documents
 *   3. submit    POST /partner/submit        (PARTNER_PROFILE_INCOMPLETE lists what is missing)
 *   4. status    GET /partner/profile        (approval is always an admin decision; demo checks are only labelled)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Icon } from '../../components/ui/Icon';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';
import { ApiError, errorMessage, fieldErrors, isNotFound } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  attachDocument, createProfile, DOC_CONTENT_TYPES, DOC_LABELS, DOC_MAX_BYTES, partnerKeys, profileQueryOptions, presignDocument, putToStorage,
  requiredDocs, submitProfile, updateProfile, VEHICLE_OPTIONS, type DocType, type PartnerProfile, type VehicleTypeValue,
} from './api';

const EDITABLE = ['DRAFT', 'REJECTED', 'APPROVAL_PENDING'];

function DetailsForm({ profile }: { profile: PartnerProfile | null }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(profile?.name ?? auth.user?.name ?? '');
  const [vehicleType, setVehicleType] = useState<string>(profile?.vehicle?.type ?? '');
  const [reg, setReg] = useState(profile?.vehicle?.registrationNumber ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const locked = profile ? !EDITABLE.includes(profile.status) : false;
  // The server refuses vehicle changes while the application is under review.
  const vehicleLocked = locked || profile?.status === 'APPROVAL_PENDING';
  const vehicle = { type: vehicleType as VehicleTypeValue, registrationNumber: reg.trim().toUpperCase() };
  const nameChanged = !profile || name.trim() !== profile.name;
  const vehicleChanged = !profile || vehicle.type !== profile.vehicle?.type || vehicle.registrationNumber !== profile.vehicle?.registrationNumber;
  const dirty = !profile || nameChanged || (vehicleChanged && !vehicleLocked);

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) return createProfile({ name: name.trim(), vehicle });
      // Send only what changed.
      return updateProfile({ ...(nameChanged ? { name: name.trim() } : {}), ...(vehicleChanged && !vehicleLocked ? { vehicle } : {}) });
    },
    onSuccess: async (p) => {
      qc.setQueryData(partnerKeys.profile, p);
      if (!profile) {
        // The profile grants DELIVERY_PARTNER; pick the role up in the access token.
        try {
          await auth.refreshUser();
        } catch {
          toast({ title: 'Profile saved', description: 'Sign out and in again if the partner home does not open.', tone: 'warn' });
        }
      }
      toast({ title: profile ? 'Details updated' : 'Profile created', description: 'Next, upload your documents.', tone: 'success' });
    },
    onError: (e) => setErrors(fieldErrors(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = 'Enter your full name (at least 2 characters).';
    if (!vehicleType) next['vehicle.type'] = 'Choose your vehicle type.';
    const r = reg.trim();
    if (r.length < 4 || r.length > 20) next['vehicle.registrationNumber'] = 'Enter the registration number as on your RC (4 to 20 characters).';
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Partner details">
      <Field label="Full name" required error={errors.name} hint="As on your ID proof.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={locked} maxLength={80} />
      </Field>
      <Field label="Vehicle type" required error={errors['vehicle.type'] ?? errors.vehicle}>
        <Select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} options={VEHICLE_OPTIONS} placeholder="Choose vehicle" disabled={vehicleLocked} />
      </Field>
      <Field label="Registration number" required error={errors['vehicle.registrationNumber']} hint={vehicleType === 'BICYCLE' ? 'For a bicycle enter any identifier you can show, e.g. frame number.' : 'For example KA05MN4321.'}>
        <Input value={reg} onChange={(e) => setReg(e.target.value)} autoCapitalize="characters" autoComplete="off" disabled={vehicleLocked} maxLength={20} />
      </Field>
      {locked ? <p className="text-sm text-slate-600">Details can't be changed after approval. Contact support to update them.</p> : null}
      {!locked && vehicleLocked ? <p className="text-sm text-slate-600">Vehicle details are locked while your application is under review. Contact support to change them.</p> : null}
      {profile && !locked && !dirty ? <p className="text-sm text-slate-600">No changes to save.</p> : null}
      <InlineError error={save.error && Object.keys(errors).length === 0 ? save.error : null} />
      <FormActions>
        <Button type="submit" loading={save.isPending} disabled={locked || !dirty}>
          {profile ? 'Save details' : 'Create profile'}
        </Button>
      </FormActions>
    </form>
  );
}

function DocumentRow({ type, profile, editable }: { type: DocType; profile: PartnerProfile; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [localError, setLocalError] = useState<string | null>(null);
  const doc = profile.documents.find((d) => d.type === type);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const ticket = await presignDocument({ type, contentType: file.type, sizeBytes: file.size });
      await putToStorage(ticket.upload, file);
      return attachDocument({ type, key: ticket.key });
    },
    onSuccess: (p) => {
      qc.setQueryData(partnerKeys.profile, p);
      toast({ title: `${DOC_LABELS[type].split(' (')[0]} uploaded`, tone: 'success' });
    },
  });

  const onFile = (file: File | undefined) => {
    setLocalError(null);
    if (!file) return;
    if (!(DOC_CONTENT_TYPES as readonly string[]).includes(file.type)) return setLocalError('Upload a JPG, PNG or PDF file.');
    if (file.size < 1 || file.size > DOC_MAX_BYTES) return setLocalError(`File must be under ${DOC_MAX_BYTES / 1024 / 1024} MB.`);
    upload.mutate(file);
  };

  const error = localError ?? (upload.error ? (upload.error instanceof ApiError ? errorMessage(upload.error) : "Upload didn't finish. Check your connection and try again.") : null);
  return (
    <li className="rounded-control border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-900">{DOC_LABELS[type]}</p>
        {doc ? (
          <Badge tone="success" icon="check">
            Uploaded
          </Badge>
        ) : (
          <Badge tone="warn">Required</Badge>
        )}
      </div>
      {doc ? (
        <p className="mt-1 text-sm text-slate-600">
          Uploaded {formatDateTime(doc.uploadedAt)}
          {doc.demoVerified ? <Badge tone="info" className="ml-2">Demo check only, not an approval</Badge> : null}
        </p>
      ) : null}
      {editable ? (
        <div className="mt-2">
          <Field label={doc ? 'Replace file' : 'Choose file'} hint="JPG, PNG or PDF, up to 5 MB." error={error ?? undefined}>
            <Input
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              disabled={upload.isPending}
              className="h-auto py-2"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </Field>
          {upload.isPending ? (
            <p role="status" className="mt-1 text-sm text-slate-600">
              Uploading…
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function SubmitPanel({ profile }: { profile: PartnerProfile }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const needed = requiredDocs(profile.vehicle?.type);
  const have = new Set(profile.documents.map((d) => d.type));
  const missing = needed.filter((t) => !have.has(t));
  const canSubmit = Boolean(profile.vehicle) && missing.length === 0;
  const [serverMissing, setServerMissing] = useState<string[]>([]);

  const submit = useMutation({
    mutationFn: submitProfile,
    onSuccess: (p) => {
      setServerMissing([]);
      qc.setQueryData(partnerKeys.profile, p);
      toast({ title: 'Submitted for review', description: 'We will notify you once an admin decides.', tone: 'success' });
    },
    onError: (e) => {
      const m = e instanceof ApiError ? (e.details as { missing?: unknown } | undefined)?.missing : undefined;
      setServerMissing(Array.isArray(m) ? m.map(String) : []);
    },
  });

  return (
    <div className="space-y-3">
      {!canSubmit ? (
        <p className="text-sm text-slate-700" role="note">
          Before you can submit: {!profile.vehicle ? 'add your vehicle details' : `upload ${missing.map((t) => DOC_LABELS[t].split(' (')[0]!.toLowerCase()).join(', ')}`}.
        </p>
      ) : null}
      {serverMissing.length ? <p role="alert" className="text-sm font-medium text-danger-700">Still missing: {serverMissing.join(', ')}</p> : null}
      <InlineError error={serverMissing.length ? null : submit.error} />
      <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={!canSubmit}>
        {profile.status === 'REJECTED' ? 'Resubmit for review' : 'Submit for review'}
      </Button>
    </div>
  );
}

function Content({ profile }: { profile: PartnerProfile | null }) {
  const status = profile?.status;
  const editable = profile ? EDITABLE.includes(profile.status) : false;
  return (
    <div className="space-y-6">
      {profile ? (
        <Card tone={status === 'REJECTED' || status === 'SUSPENDED' ? 'danger' : status === 'APPROVED' ? 'brand' : 'default'} aria-label="Application status">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Application status</h2>
            <StatusPill kind="partner" status={profile.status} />
          </div>
          <p className="mt-2 text-[0.9375rem] text-slate-700" aria-live="polite">
            {status === 'DRAFT' && 'Complete the steps below and submit for review.'}
            {status === 'APPROVAL_PENDING' && 'Submitted. An admin is reviewing your documents. You can still replace a document while you wait.'}
            {status === 'APPROVED' && 'You are approved. Go online to start taking deliveries.'}
            {status === 'REJECTED' && `Not approved${profile.statusReason ? `: ${profile.statusReason}` : ''}. Fix the issue and resubmit.`}
            {status === 'SUSPENDED' && `Your account is suspended${profile.statusReason ? `: ${profile.statusReason}` : ''}. Contact Thali support.`}
          </p>
          {status === 'APPROVED' ? (
            <ButtonLink to="/partner" className="mt-3">
              Go to partner home
            </ButtonLink>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader title="1. Your details" description="Your name and the vehicle you will deliver with." />
        <div className="mt-3">
          <DetailsForm key={profile?.id ?? 'new'} profile={profile} />
        </div>
      </Card>

      {profile?.vehicle ? (
        <>
          <Card>
            <CardHeader title="2. Documents" description="Clear photos or PDFs. Documents are stored privately and only reviewed by Thali admins." />
            <ul className="mt-3 space-y-3">
              {requiredDocs(profile.vehicle.type).map((t) => (
                <DocumentRow key={t} type={t} profile={profile} editable={editable} />
              ))}
            </ul>
          </Card>
          {status === 'DRAFT' || status === 'REJECTED' ? (
            <Card>
              <CardHeader title="3. Submit for review" />
              <div className="mt-3">
                <SubmitPanel profile={profile} />
              </div>
            </Card>
          ) : null}
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Icon name="info" size={16} /> Documents and submission unlock after you save your details.
        </p>
      )}
    </div>
  );
}

export default function PartnerOnboarding() {
  const profile = useQuery(profileQueryOptions());
  const noProfile = profile.isError && isNotFound(profile.error);

  return (
    <>
      <PageHeader title="Become a delivery partner" description="Set up your profile, upload your documents and submit for approval." />
      {noProfile ? <Content profile={null} /> : <QueryState query={profile}>{(p) => <Content profile={p} />}</QueryState>}
    </>
  );
}
