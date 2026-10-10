/** Account (PRD C-7): profile (name, optional email), notification preferences, links, sign out / everywhere. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Field,
  FormActions,
  Icon,
  InlineError,
  Input,
  PageHeader,
  QueryState,
  Skeleton,
  Switch,
  useToast,
  type IconName,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { formatPhone } from '../../lib/format';
import type { Me, NotificationPrefs } from './api';

const ME_KEY = ['me', 'profile'] as const;

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
    mutationFn: () =>
      api<Me>('/me', {
        method: 'PATCH',
        body: { ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) },
      }),
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
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Phone" hint="Your sign-in number can't be changed here.">
        <Input value={formatPhone(me.phone)} readOnly disabled />
      </Field>
      <Field label="Name" error={errs.name}>
        <Input value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </Field>
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
    <div className="divide-y divide-slate-100">
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
  { to: '/membership', label: 'Membership', icon: 'star' },
  { to: '/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/support', label: 'Help & support', icon: 'ticket' },
];

function AccountContent() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => api<Me>('/me') });
  const { signOut, signOutEverywhere } = useAuth();
  const navigate = useNavigate();
  const [confirmAll, setConfirmAll] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Profile" />
          <QueryState query={me} loading={<Skeleton className="h-40 w-full" />}>
            {(m) => <ProfileForm me={m} />}
          </QueryState>
        </Card>
        <Card>
          <CardHeader title="Notifications" description="Choose how we contact you. Security messages (like sign-in codes) are always sent." />
          <QueryState query={me} loading={<Skeleton className="h-32 w-full" />}>
            {(m) => <Prefs me={m} />}
          </QueryState>
        </Card>
      </div>
      <aside className="space-y-4">
        <Card padding="sm">
          <nav aria-label="Account">
            <ul>
              {LINKS.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="flex min-h-touch items-center gap-3 rounded-control px-2 text-slate-800 hover:bg-slate-50">
                    <Icon name={l.icon} size={18} className="text-slate-500" />
                    <span className="flex-1">{l.label}</span>
                    <Icon name="chevron-right" size={16} className="text-slate-400" />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
        <Card padding="sm" className="space-y-2">
          <Button
            variant="secondary"
            fullWidth
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
          <Button variant="ghost" fullWidth onClick={() => setConfirmAll(true)}>
            Sign out of all devices
          </Button>
        </Card>
      </aside>
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
    <>
      <PageHeader title="Account" />
      <RequireAuth signInMessage="Sign in to manage your profile, addresses and preferences.">
        <AccountContent />
      </RequireAuth>
    </>
  );
}
