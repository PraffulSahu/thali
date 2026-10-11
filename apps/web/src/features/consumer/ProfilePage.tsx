/**
 * Account (design-spec §7.2; PRD C-7): section cards
 *   Profile — photo (IDN-3: `POST /me/uploads` → PUT to the signed URL → `PATCH /me {avatarKey}`; remove = null),
 *             name, phone read-only (mono, "Verified"), optional email
 *   Notifications — 4 switches (`PUT /me/notification-prefs`, optimistic with rollback)
 *   Sessions — Sign out · Sign out of all devices (confirm)
 * plus links to addresses, Thali Plus, notifications and support.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  FormActions,
  Icon,
  InlineError,
  Input,
  PageHeader,
  SectionCard,
  Skeleton,
  Switch,
  useToast,
  type IconName,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ApiError, errorMessage, fieldErrors } from '../../lib/errors';
import { formatPhone } from '../../lib/format';
import type { Me, NotificationPrefs } from './api';
import { PageContainer } from './ConsumerLayout';

const ME_KEY = ['me', 'profile'] as const;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_MAX = 2 * 1024 * 1024;

interface UploadTicket {
  key: string;
  upload: { url: string; method: 'PUT'; headers?: Record<string, string> };
}

/** IDN-3 avatar: signed upload then PATCH /me with the key (server verifies content). */
async function uploadAvatar(file: File): Promise<Me> {
  if (!AVATAR_TYPES.includes(file.type)) throw new ApiError({ code: 'FILE_INVALID', status: 422, message: 'Use a JPG, PNG or WebP photo.' });
  if (file.size > AVATAR_MAX) throw new ApiError({ code: 'FILE_INVALID', status: 422, message: 'Photos must be 2 MB or smaller.' });
  const ticket = await api<UploadTicket>('/me/uploads', { method: 'POST', body: { contentType: file.type, sizeBytes: file.size } });
  const put = await fetch(ticket.upload.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type, ...(ticket.upload.headers ?? {}) } });
  if (!put.ok) throw new ApiError({ code: 'UPLOAD_FAILED', status: put.status, message: 'The photo upload failed. Please try again.' });
  return api<Me>('/me', { method: 'PATCH', body: { avatarKey: ticket.key } });
}

function AvatarEditor({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const done = (m: Me) => {
    qc.setQueryData(ME_KEY, m);
    void refreshUser().catch(() => undefined);
  };
  const upload = useMutation({ mutationFn: uploadAvatar, onSuccess: (m) => (done(m), toast({ title: 'Photo updated', tone: 'success' })) });
  const remove = useMutation({ mutationFn: () => api<Me>('/me', { method: 'PATCH', body: { avatarKey: null } }), onSuccess: done });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) upload.mutate(f);
  };
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar name={me.name || formatPhone(me.phone) || 'You'} src={me.avatarUrl ?? null} size={64} bordered />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" icon="edit" loading={upload.isPending} onClick={() => input.current?.click()}>
            {me.avatarUrl ? 'Change photo' : 'Add photo'}
          </Button>
          {me.avatarUrl ? (
            <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-fg-3">JPG, PNG or WebP, up to 2 MB. Shown to you only (and as your initials elsewhere).</p>
        <InlineError error={upload.error ?? remove.error} />
      </div>
      <input ref={input} type="file" accept={AVATAR_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-label="Choose a profile photo" onChange={onFile} />
    </div>
  );
}

function ProfileForm({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { refreshUser } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(me.name ?? '');
  const [email, setEmail] = useState(me.email ?? '');
  useEffect(() => {
    setName(me.name ?? '');
    setEmail(me.email ?? '');
  }, [me.name, me.email]);
  const save = useMutation({
    mutationFn: () => api<Me>('/me', { method: 'PATCH', body: { ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) } }),
    onSuccess: (m) => {
      qc.setQueryData(ME_KEY, m);
      void refreshUser().catch(() => undefined);
      toast({ title: 'Profile saved', tone: 'success' });
    },
  });
  const errs = fieldErrors(save.error);
  const dirty = name !== (me.name ?? '') || email !== (me.email ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <AvatarEditor me={me} />
      <Field label="Name" error={errs.name}>
        <Input value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-fg">Phone</span>
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[15px]">{formatPhone(me.phone) || '—'}</span>
          {me.phone ? (
            <Badge tone="ok" icon="check">
              Verified
            </Badge>
          ) : null}
        </span>
        <span className="text-[13px] text-fg-3">Your sign-in number can&rsquo;t be changed here.</span>
      </div>
      <Field label="Email" optional hint="For order receipts." error={errs.email}>
        <Input type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <InlineError error={save.error && !Object.keys(errs).length ? save.error : null} />
      <FormActions>
        <Button type="submit" loading={save.isPending} disabled={!dirty}>
          Save profile
        </Button>
      </FormActions>
    </form>
  );
}

const PREF_LABELS: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  { key: 'orderSms', label: 'Order updates by SMS', description: 'Accepted, out for delivery, refunds.' },
  { key: 'orderEmail', label: 'Order updates by email', description: 'Receipts and refund confirmations (needs an email).' },
  { key: 'marketingSms', label: 'Offers by SMS', description: 'Occasional deals near you.' },
  { key: 'marketingEmail', label: 'Offers by email', description: 'Occasional deals near you.' },
];

function Prefs({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: (prefs: NotificationPrefs) => api<NotificationPrefs>('/me/notification-prefs', { method: 'PUT', body: prefs }),
    onMutate: (prefs) => {
      const prev = qc.getQueryData<Me>(ME_KEY);
      qc.setQueryData<Me>(ME_KEY, (m) => (m ? { ...m, notificationPrefs: prefs } : m));
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(ME_KEY, ctx.prev);
      toast({ title: "Couldn't save preferences", description: errorMessage(e), tone: 'danger' });
    },
    onSuccess: (prefs) => qc.setQueryData<Me>(ME_KEY, (m) => (m ? { ...m, notificationPrefs: prefs } : m)),
  });
  return (
    <div className="flex flex-col divide-y divide-line">
      {PREF_LABELS.map((p) => (
        <Switch
          key={p.key}
          label={p.label}
          description={p.description}
          checked={me.notificationPrefs[p.key]}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ ...me.notificationPrefs, [p.key]: e.target.checked })}
        />
      ))}
    </div>
  );
}

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/orders', label: 'Your orders', icon: 'receipt' },
  { to: '/account/addresses', label: 'Saved addresses', icon: 'location' },
  { to: '/membership', label: 'Thali Plus', icon: 'star' },
  { to: '/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/support', label: 'Help & support', icon: 'ticket' },
  { to: '/offers', label: 'Offers', icon: 'tag' },
];

function AccountContent() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api<Me>('/me') });
  const { signOut, signOutEverywhere } = useAuth();
  const navigate = useNavigate();
  const [confirmAll, setConfirmAll] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const body = (render: (m: Me) => React.ReactNode, h = 'h-40') =>
    me.isPending ? <Skeleton className={`${h} w-full`} /> : me.isError ? <ErrorState compact error={me.error} title="Couldn't load your profile" onRetry={() => void me.refetch()} /> : render(me.data);
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
        <SectionCard title="Profile" bodyClassName="p-5">
          {body((m) => <ProfileForm me={m} />)}
        </SectionCard>
        <SectionCard title="Notifications" meta="Security messages (like sign-in codes) are always sent." bodyClassName="px-5 py-2">
          {body((m) => <Prefs me={m} />, 'h-32')}
        </SectionCard>
        <SectionCard title="Sessions" bodyClassName="flex flex-wrap gap-2.5 p-5">
          <Button
            variant="ghost"
            icon="logout"
            loading={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await signOut();
              navigate('/');
            }}
          >
            Sign out
          </Button>
          <Button variant="danger-outline" onClick={() => setConfirmAll(true)}>
            Sign out of all devices
          </Button>
        </SectionCard>
      </div>
      <nav aria-label="Account" className="w-full flex-[1_1_260px] overflow-hidden rounded-card border border-line bg-card lg:max-w-[320px]">
        <ul className="divide-y divide-line">
          {LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="flex min-h-touch items-center gap-3 px-4 text-[14.5px] text-fg hover:bg-fill">
                <Icon name={l.icon} size={18} className="text-fg-3" />
                <span className="flex-1">{l.label}</span>
                <Icon name="chevron-right" size={16} className="text-fg-3" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Sign out everywhere?"
        description="This ends your sessions on every phone and browser, including this one."
        confirmLabel="Sign out everywhere"
        tone="danger"
        onConfirm={async () => {
          await signOutEverywhere();
          navigate('/');
        }}
      />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <PageContainer>
      <PageHeader size="page" title="Account" />
      <RequireAuth signInMessage="Sign in to manage your profile, addresses and preferences.">
        <AccountContent />
      </RequireAuth>
    </PageContainer>
  );
}
