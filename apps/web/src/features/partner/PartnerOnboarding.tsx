/**
 * Partner onboarding / Profile & documents `/partner/onboarding` (design-spec §7.1 wizard + §7.4; sign-in only —
 * DELIVERY_PARTNER is granted when the profile is created):
 *   1 Profile    POST /partner/profile {name} (create → auth.refreshUser()) | PATCH {name}
 *   2 Vehicle    4 option cards + registration → PATCH {vehicle} (locked while under review / after approval)
 *   3 Documents  POST /partner/uploads (presign) → PUT to storage → POST /partner/documents (staged progress)
 *   4 Review     missing items with "Fix" links → POST /partner/submit (Resubmit after rejection)
 * A status banner on top explains Draft / Awaiting approval / Rejected (reason) / Suspended (reason) / Approved.
 * Approval is always an admin decision; demo document checks are only labelled.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Input } from '../../components/ui/Input';
import { StatusBanner } from '../../components/ui/Notice';
import { OptionCard } from '../../components/ui/OptionCard';
import { PageHeader } from '../../components/ui/PageHeader';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { QueryState } from '../../components/ui/QueryState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Stepper } from '../../components/ui/Stepper';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { ApiError, errorMessage, fieldErrors, isNotFound } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  attachDocument, createProfile, DOC_CONTENT_TYPES, DOC_LABELS, DOC_MAX_BYTES, partnerKeys, profileQueryOptions, presignDocument, putToStorage,
  requiredDocs, submitProfile, updateProfile, VEHICLE_OPTIONS, type DocType, type PartnerProfile, type VehicleTypeValue,
} from './api';

const STEPS = ['Profile', 'Vehicle', 'Documents', 'Review & submit'] as const;
type Step = 0 | 1 | 2 | 3;

const NAME_EDITABLE = ['DRAFT', 'REJECTED', 'APPROVAL_PENDING'];
const VEHICLE_EDITABLE = ['DRAFT', 'REJECTED'];
const DOCS_EDITABLE = ['DRAFT', 'REJECTED', 'APPROVAL_PENDING'];

const VEHICLE_HINT: Record<VehicleTypeValue, string> = {
  BIKE: 'Licence + RC needed',
  SCOOTER: 'Licence + RC needed',
  BICYCLE: 'Only ID proof needed',
  CAR: 'Licence + RC needed',
};

const shortDoc = (t: DocType) => DOC_LABELS[t].split(' (')[0]!;

function missingFor(p: PartnerProfile | null) {
  const have = new Set(p?.documents.map((d) => d.type) ?? []);
  return {
    name: !p?.name,
    vehicle: !p?.vehicle,
    docs: p?.vehicle ? requiredDocs(p.vehicle.type).filter((t) => !have.has(t)) : [],
  };
}

function firstStep(p: PartnerProfile | null): Step {
  if (!p) return 0;
  const m = missingFor(p);
  if (m.name) return 0;
  if (m.vehicle) return 1;
  if (m.docs.length) return 2;
  return 3;
}

/* ------------------------------------------------------------------ status banner */

function ApplicationBanner({ profile }: { profile: PartnerProfile }) {
  const r = profile.statusReason;
  switch (profile.status) {
    case 'DRAFT':
      return (
        <StatusBanner tone="warn" title="Application in progress">
          Finish the steps below and submit for review. You can go online once Thali approves you.
        </StatusBanner>
      );
    case 'APPROVAL_PENDING':
      return (
        <StatusBanner tone="info" title="Awaiting approval">
          Submitted. Thali is reviewing your documents — you can still replace a document while you wait. Your vehicle is locked during review.
        </StatusBanner>
      );
    case 'REJECTED':
      return (
        <StatusBanner tone="bad" title="Your application wasn’t approved">
          {r ? `Reason: ${r}. ` : ''}Fix the issue below and resubmit.
        </StatusBanner>
      );
    case 'SUSPENDED':
      return (
        <StatusBanner tone="bad" title="Your account is suspended">
          {r ? `Reason: ${r}. ` : ''}Contact Thali support to get reinstated.
        </StatusBanner>
      );
    case 'APPROVED':
      return (
        <StatusBanner tone="ok" title="You’re approved" action={<ButtonLink to="/partner">Go to partner home</ButtonLink>}>
          Your details and documents are locked. Contact Thali support to change them.
        </StatusBanner>
      );
  }
}

/* ------------------------------------------------------------------ steps */

function StepCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-card border border-line bg-card">
      <header className="border-b border-line px-5 py-4 max-sm:px-4">
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">{title}</h2>
        {description ? <p className="mt-1 text-[13px] text-fg-3">{description}</p> : null}
      </header>
      <div className="px-5 py-5 max-sm:px-4">{children}</div>
      {footer ? <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2 px-5 py-3.5 max-sm:px-4">{footer}</div> : null}
    </section>
  );
}

function ProfileStep({ profile, onNext }: { profile: PartnerProfile | null; onNext: () => void }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(profile?.name ?? auth.user?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const editable = !profile || NAME_EDITABLE.includes(profile.status);
  const changed = !profile || name.trim() !== profile.name;

  const save = useMutation({
    mutationFn: async () => (profile ? updateProfile({ name: name.trim() }) : createProfile({ name: name.trim() })),
    onSuccess: async (p) => {
      qc.setQueryData(partnerKeys.profile, p);
      if (!profile) {
        // The profile grants DELIVERY_PARTNER; pick the role up in the access token.
        try {
          await auth.refreshUser();
        } catch {
          toast({ title: 'Profile created', description: 'Sign out and in again if the partner home doesn’t open.', tone: 'warn' });
        }
      }
      onNext();
    },
    onError: (e) => setError(fieldErrors(e).name ?? fieldErrors(e)['body.name'] ?? null),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable || !changed) return onNext();
    if (name.trim().length < 2) return setError('Enter your full name (at least 2 characters).');
    setError(null);
    save.mutate();
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Profile">
      <StepCard
        title="1. Your profile"
        description="Your name as it appears on your ID proof."
        footer={
          <>
            <span />
            <Button type="submit" loading={save.isPending}>
              {!profile ? 'Create profile & continue' : editable && changed ? 'Save & continue' : 'Continue'}
            </Button>
          </>
        }
      >
        <div className="max-w-[560px] space-y-3">
          <Field label="Full name" required error={error ?? undefined} hint="As on your ID proof.">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={!editable} maxLength={80} />
          </Field>
          {!editable ? <p className="text-[13px] text-fg-3">Your name can’t be changed after approval. Contact Thali support to update it.</p> : null}
          <InlineError error={save.error && !error ? save.error : null} />
        </div>
      </StepCard>
    </form>
  );
}

function VehicleStep({ profile, onBack, onNext }: { profile: PartnerProfile; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<VehicleTypeValue | ''>(profile.vehicle?.type ?? '');
  const [reg, setReg] = useState(profile.vehicle?.registrationNumber ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editable = VEHICLE_EDITABLE.includes(profile.status);
  const vehicle = { type: type as VehicleTypeValue, registrationNumber: reg.trim().toUpperCase().replace(/\s+/g, '') };
  const changed = vehicle.type !== profile.vehicle?.type || vehicle.registrationNumber !== profile.vehicle?.registrationNumber;

  const save = useMutation({
    mutationFn: () => updateProfile({ vehicle }),
    onSuccess: (p) => {
      qc.setQueryData(partnerKeys.profile, p);
      onNext();
    },
    onError: (e) => setErrors(fieldErrors(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable || !changed) return profile.vehicle ? onNext() : undefined;
    const next: Record<string, string> = {};
    if (!type) next['vehicle.type'] = 'Choose your vehicle type.';
    if (vehicle.registrationNumber.length < 4 || vehicle.registrationNumber.length > 20) next['vehicle.registrationNumber'] = 'Enter the registration number as on your RC (4 to 20 characters).';
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };
  const lockReason =
    profile.status === 'APPROVAL_PENDING'
      ? 'Your vehicle is locked while your application is under review (it decides which documents are needed). Contact Thali support to change it.'
      : !editable
        ? 'Vehicle details can’t change after approval. Contact Thali support to update them.'
        : null;

  return (
    <form onSubmit={submit} noValidate aria-label="Vehicle">
      <StepCard
        title="2. Your vehicle"
        description="The vehicle you’ll deliver with. It decides which documents you need."
        footer={
          <>
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!editable && !profile.vehicle}>
              {editable && changed ? 'Save & continue' : 'Continue'}
            </Button>
          </>
        }
      >
        <div className="max-w-[560px] space-y-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Vehicle type</legend>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2">
              {VEHICLE_OPTIONS.map((o) => (
                <OptionCard
                  key={o.value}
                  type="radio"
                  name="vehicle-type"
                  value={o.value}
                  label={o.label}
                  description={VEHICLE_HINT[o.value]}
                  checked={type === o.value}
                  onChange={() => setType(o.value)}
                  disabled={!editable}
                />
              ))}
            </div>
            {errors['vehicle.type'] ?? errors.vehicle ? (
              <p role="alert" className="mt-1.5 text-[13px] text-bad">
                {errors['vehicle.type'] ?? errors.vehicle}
              </p>
            ) : null}
          </fieldset>
          <Field
            label="Registration number"
            required
            error={errors['vehicle.registrationNumber']}
            hint={type === 'BICYCLE' ? 'For a bicycle enter any identifier you can show, e.g. the frame number.' : 'As on your RC, for example KA05MN4321.'}
          >
            <Input value={reg} onChange={(e) => setReg(e.target.value)} autoCapitalize="characters" autoComplete="off" disabled={!editable} maxLength={20} className="font-mono uppercase" />
          </Field>
          {lockReason ? (
            <p className="flex items-start gap-2 text-[13px] text-fg-3">
              <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
              {lockReason}
            </p>
          ) : null}
          <InlineError error={save.error && Object.keys(errors).length === 0 ? save.error : null} />
        </div>
      </StepCard>
    </form>
  );
}

const UPLOAD_STAGES = ['Preparing upload', 'Uploading file', 'Attaching to your profile'] as const;

function DocumentRow({ type, profile, editable }: { type: DocType; profile: PartnerProfile; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [localError, setLocalError] = useState<string | null>(null);
  const [stage, setStage] = useState<number | null>(null);
  const doc = profile.documents.find((d) => d.type === type);
  const inputId = `doc-${type}`;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setStage(0);
      const ticket = await presignDocument({ type, contentType: file.type, sizeBytes: file.size });
      setStage(1);
      await putToStorage(ticket.upload, file);
      setStage(2);
      return attachDocument({ type, key: ticket.key });
    },
    onSuccess: (p) => {
      qc.setQueryData(partnerKeys.profile, p);
      toast({ title: `${shortDoc(type)} uploaded`, tone: 'success' });
    },
    onSettled: () => setStage(null),
  });

  const onFile = (file: File | undefined) => {
    setLocalError(null);
    if (!file) return;
    if (!(DOC_CONTENT_TYPES as readonly string[]).includes(file.type)) return setLocalError('Upload a JPG, PNG or PDF file.');
    if (file.size < 1 || file.size > DOC_MAX_BYTES) return setLocalError(`File must be under ${DOC_MAX_BYTES / 1024 / 1024} MB.`);
    upload.mutate(file);
  };

  const error = localError ?? (upload.error ? (upload.error instanceof ApiError ? errorMessage(upload.error) : 'Upload didn’t finish. Check your connection and try again.') : null);
  return (
    <li className="flex flex-col gap-2.5 border-b border-line px-5 py-4 last:border-0 max-sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Icon name={doc ? 'check-circle' : 'receipt'} size={18} className={doc ? 'text-ok' : 'text-fg-3'} />
        <div className="min-w-[180px] flex-1">
          <p className="text-[14.5px] font-medium">{DOC_LABELS[type]}</p>
          {doc ? <p className="text-[13px] text-fg-3">Uploaded {formatDateTime(doc.uploadedAt)}</p> : <p className="text-[13px] text-fg-3">JPG, PNG or PDF, up to 5 MB</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {doc ? (
            <Badge tone="ok" dot>
              Uploaded
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              Required
            </Badge>
          )}
          {doc?.demoVerified ? <Badge tone="info">Demo check only, not an approval</Badge> : null}
        </div>
        {editable ? (
          <label
            htmlFor={inputId}
            className={cn(
              'inline-flex h-9 cursor-pointer items-center gap-2 rounded-pill border border-line bg-card px-3.5 text-[13.5px] font-bold hover:border-line-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-acc',
              upload.isPending && 'pointer-events-none opacity-45',
            )}
          >
            <Icon name="plus" size={15} />
            {doc ? 'Replace file' : 'Choose file'}
            <input
              id={inputId}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              disabled={upload.isPending}
              aria-label={`${doc ? 'Replace file' : 'Choose file'}: ${DOC_LABELS[type]}`}
              className="sr-only"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>
      {stage !== null ? (
        <div role="status" className="max-w-[420px]">
          <ProgressBar value={stage + 1} max={3} label={`Uploading ${shortDoc(type)}`} left={UPLOAD_STAGES[stage]} right={`Step ${stage + 1} of 3`} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-bad">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : null}
    </li>
  );
}

function DocumentsStep({ profile, onBack, onNext }: { profile: PartnerProfile; onBack: () => void; onNext: () => void }) {
  const editable = DOCS_EDITABLE.includes(profile.status);
  return (
    <section aria-label="Documents" className="overflow-hidden rounded-card border border-line bg-card">
      <header className="border-b border-line px-5 py-4 max-sm:px-4">
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">3. Documents</h2>
        <p className="mt-1 text-[13px] text-fg-3">Clear photos or PDFs. Stored privately and only reviewed by Thali admins.</p>
      </header>
      {profile.vehicle ? (
        <ul>
          {requiredDocs(profile.vehicle.type).map((t) => (
            <DocumentRow key={t} type={t} profile={profile} editable={editable} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-5 text-sm text-fg-3">Add your vehicle first — it decides which documents you need.</p>
      )}
      {!editable ? <p className="border-t border-line px-5 py-3 text-[13px] text-fg-3">Documents can’t be replaced after approval. Contact Thali support.</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2 px-5 py-3.5 max-sm:px-4">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </section>
  );
}

function ReviewStep({ profile, onBack, goTo }: { profile: PartnerProfile; onBack: () => void; goTo: (s: Step) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = missingFor(profile);
  const [serverMissing, setServerMissing] = useState<string[]>([]);
  const canSubmit = !m.name && !m.vehicle && m.docs.length === 0;
  const submittable = profile.status === 'DRAFT' || profile.status === 'REJECTED';

  const submit = useMutation({
    mutationFn: submitProfile,
    onSuccess: (p) => {
      setServerMissing([]);
      qc.setQueryData(partnerKeys.profile, p);
      toast({ title: 'Submitted for review', description: 'We’ll let you know once Thali decides.', tone: 'success' });
    },
    onError: (e) => {
      const missing = e instanceof ApiError ? (e.details as { missing?: unknown } | undefined)?.missing : undefined;
      setServerMissing(Array.isArray(missing) ? missing.map(String) : []);
    },
  });

  const rows: Array<{ label: string; ok: boolean; value?: string; fix?: Step }> = [
    { label: 'Full name', ok: !m.name, value: profile.name, fix: 0 },
    { label: 'Vehicle', ok: !m.vehicle, value: profile.vehicle ? `${VEHICLE_OPTIONS.find((o) => o.value === profile.vehicle!.type)?.label ?? profile.vehicle.type} · ${profile.vehicle.registrationNumber}` : undefined, fix: 1 },
    ...(profile.vehicle ? requiredDocs(profile.vehicle.type) : (['ID_PROOF'] as DocType[])).map((t) => ({ label: shortDoc(t), ok: !m.docs.includes(t) && Boolean(profile.vehicle), fix: 2 as Step })),
  ];

  return (
    <section aria-label="Review and submit" className="overflow-hidden rounded-card border border-line bg-card">
      <header className="border-b border-line px-5 py-4 max-sm:px-4">
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">4. Review &amp; submit</h2>
        <p className="mt-1 text-[13px] text-fg-3">Check everything is in place. Approval is always a decision by Thali — never automatic.</p>
      </header>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-0 max-sm:px-4">
            <Icon name={r.ok ? 'check-circle' : 'alert'} size={18} className={r.ok ? 'text-ok' : 'text-warn'} />
            <span className="min-w-[140px] flex-1 text-[14px]">
              <span className="font-medium">{r.label}</span>
              {r.value ? <span className="text-fg-3"> · {r.value}</span> : null}
              {!r.ok ? <span className="text-warn"> · missing</span> : null}
            </span>
            {!r.ok && r.fix !== undefined ? (
              <Button variant="outline" size="xs" onClick={() => goTo(r.fix!)}>
                Fix
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {serverMissing.length ? (
        <p role="alert" className="border-t border-line px-5 py-3 text-[13px] font-medium text-bad">
          Still missing: {serverMissing.join(', ')}
        </p>
      ) : null}
      {submit.error && !serverMissing.length ? <InlineError error={submit.error} className="border-t border-line px-5 py-3" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2 px-5 py-3.5 max-sm:px-4">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {submittable ? (
          <Button onClick={() => submit.mutate()} loading={submit.isPending} disabled={!canSubmit}>
            {profile.status === 'REJECTED' ? 'Resubmit for review' : 'Submit for review'}
          </Button>
        ) : (
          <span className="text-[13px] text-fg-3">{profile.status === 'APPROVAL_PENDING' ? 'Submitted — awaiting approval' : profile.status === 'APPROVED' ? 'Approved' : 'Submission closed'}</span>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page */

function Wizard({ profile }: { profile: PartnerProfile | null }) {
  const [step, setStep] = useState<Step>(() => firstStep(profile));
  const go = (s: Step) => {
    setStep(s);
    document.getElementById('main')?.scrollTo?.({ top: 0 });
  };
  // Steps after the profile need a profile; never render them without one.
  const current: Step = profile ? step : 0;

  return (
    <div className="flex max-w-[860px] flex-col gap-[18px]">
      {profile ? <ApplicationBanner profile={profile} /> : null}
      <nav aria-label="Application steps" className="rounded-card border border-line bg-card px-5 py-4 max-sm:px-4">
        <Stepper label="Application steps" steps={STEPS} current={current} responsive={false} />
        {profile ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {STEPS.map((label, i) => (
              <Button key={label} variant={i === current ? 'tonal' : 'ghost'} size="xs" aria-current={i === current ? 'step' : undefined} onClick={() => go(i as Step)}>
                {i + 1}. {label}
              </Button>
            ))}
          </div>
        ) : null}
      </nav>
      {current === 0 ? <ProfileStep key={profile?.id ?? 'new'} profile={profile} onNext={() => go(1)} /> : null}
      {current === 1 && profile ? <VehicleStep key={profile.id} profile={profile} onBack={() => go(0)} onNext={() => go(2)} /> : null}
      {current === 2 && profile ? <DocumentsStep profile={profile} onBack={() => go(1)} onNext={() => go(3)} /> : null}
      {current === 3 && profile ? <ReviewStep profile={profile} onBack={() => go(2)} goTo={go} /> : null}
    </div>
  );
}

export default function PartnerOnboarding() {
  const profile = useQuery(profileQueryOptions());
  const noProfile = profile.isError && isNotFound(profile.error);
  const title = profile.data ? 'Profile & documents' : 'Become a delivery partner';

  return (
    <>
      <PageHeader
        title={title}
        description={profile.data ? 'Your details, vehicle and documents for Thali deliveries.' : 'Set up your profile, add your vehicle, upload documents and submit for approval.'}
      />
      {noProfile ? (
        <Wizard profile={null} />
      ) : (
        <QueryState
          query={profile}
          loading={
            <div className="flex max-w-[860px] flex-col gap-[18px]">
              <Skeleton className="h-14 w-full rounded-field" />
              <Skeleton className="h-20 w-full rounded-card" />
              <Skeleton className="h-64 w-full rounded-card" />
            </div>
          }
        >
          {(p) => <Wizard key={p.id} profile={p} />}
        </QueryState>
      )}
    </>
  );
}
