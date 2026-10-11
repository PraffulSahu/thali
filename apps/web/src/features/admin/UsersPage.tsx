/** `/admin/users`: search users, view roles, block/unblock; super-admins can create another admin. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Select } from '../../components/ui/Select';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/errors';
import { formatDate, formatPhone } from '../../lib/format';
import { createAdminUser, listUsers, qk, setUserBlocked, type AdminUser } from './api';
import { FilterBar, KeyValues, Mono, useAdminMutation, useAdminRoles } from './shared';

const ROLE_OPTIONS = ['CONSUMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER', 'ADMIN'].map((r) => ({ value: r, label: humanize(r) }));
const ADMIN_ROLES = ['SUPER_ADMIN', 'OPS', 'FINANCE', 'SUPPORT'];

function CreateAdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const create = useAdminMutation(createAdminUser, { success: 'Admin account created', invalidate: [['admin', 'users']], errorTitle: "Couldn't create the admin" });
  const errors = fieldErrors(create.error);

  const close = () => {
    setEmail('');
    setName('');
    setRoles([]);
    setCreated(null);
    create.reset();
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !name.trim() || roles.length === 0) return;
    const res = await create.mutateAsync({ email: email.trim(), name: name.trim(), adminRoles: roles }).catch(() => null);
    if (res) setCreated({ email: res.user.email ?? email, password: res.oneTimePassword });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'Admin created' : 'Add an admin'}
      description={created ? undefined : 'They sign in with the one-time password, then enrol an authenticator app.'}
      footer={
        <FormActions>
          {created ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button type="submit" form="create-admin-form" loading={create.isPending} disabled={!email.trim() || !name.trim() || roles.length === 0}>
                Create admin
              </Button>
            </>
          )}
        </FormActions>
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          <p className="text-[0.9375rem]">Share this one-time password with {created.email} through a secure channel. It is shown only once.</p>
          <Mono className="select-all rounded-control bg-bg-2 p-3 text-base text-fg">{created.password}</Mono>
        </div>
      ) : (
        <form id="create-admin-form" onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" required error={errors.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Name" required error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-fg">Admin roles <span className="text-bad">*</span></legend>
            {ADMIN_ROLES.map((r) => (
              <Checkbox
                key={r}
                label={humanize(r)}
                checked={roles.includes(r)}
                onChange={(e) => setRoles((cur) => (e.target.checked ? [...cur, r] : cur.filter((x) => x !== r)))}
              />
            ))}
            {errors.adminRoles ? <p className="text-sm font-medium text-bad">{errors.adminRoles}</p> : null}
          </fieldset>
          <InlineError error={create.error && Object.keys(errors).length === 0 ? create.error : null} />
        </form>
      )}
    </Dialog>
  );
}

export default function UsersPage() {
  const auth = useAuth();
  const { isSuper, canOps, canSupport } = useAdminRoles();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ q: urlQ, role: '', status: '' });
  // ⌘K "Search users for …" and user results land here with ?q=
  useEffect(() => {
    setQ(urlQ);
    setApplied((a) => (a.q === urlQ ? a : { ...a, q: urlQ }));
  }, [urlQ]);
  const [target, setTarget] = useState<{ user: AdminUser; block: boolean } | null>(null);
  const [detail, setDetail] = useState<AdminUser | null>(null);
  const [adding, setAdding] = useState(false);
  const pages = useCursorPages();

  const query = useQuery({
    queryKey: qk.users({ ...applied, cursor: pages.cursor }),
    queryFn: () => listUsers({ q: applied.q || undefined, role: applied.role || undefined, status: applied.status || undefined, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const block = useAdminMutation(({ user, blocked, reason }: { user: AdminUser; blocked: boolean; reason?: string }) => setUserBlocked(user.id, blocked, reason), {
    success: (_d, v) => (v.blocked ? 'User blocked and signed out everywhere' : 'User unblocked'),
    invalidate: [['admin', 'users']],
  });
  const canBlock = canOps || canSupport;

  const columns: Column<AdminUser>[] = [
    { key: 'name', header: 'User', cell: (u) => u.name || u.email || formatPhone(u.phone) || u.id, primary: true },
    { key: 'contact', header: 'Contact', cell: (u) => <span className="font-mono text-[12.5px]">{[formatPhone(u.phone), u.email].filter(Boolean).join(' · ') || '—'}</span>, secondary: true },
    {
      key: 'roles',
      header: 'Roles',
      cell: (u) => (
        <span className="flex flex-wrap gap-1">
          {u.roles.map((r) => <Badge key={r} tone={r === 'ADMIN' ? 'acc' : 'neu'} density="dense">{humanize(r)}</Badge>)}
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (u) => <StatusPill kind="user" status={u.status} density="dense" /> },
    { key: 'joined', header: 'Joined', cell: (u) => <span className="text-fg-3">{formatDate(u.createdAt)}</span>, hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader
        title="Users and roles"
        description="Find customers, owners, partners and admins. Blocking signs the user out everywhere."
        actions={isSuper ? <Button icon="plus" onClick={() => setAdding(true)}>Add admin</Button> : undefined}
      />
      <FilterBar
        onSubmit={() => {
          pages.reset();
          setApplied({ q: q.trim(), role, status });
          const p = new URLSearchParams(params);
          if (q.trim()) p.set('q', q.trim());
          else p.delete('q');
          setParams(p, { replace: true });
        }}
      >
        <Field label="Search" className="lg:col-span-2">
          <Input type="search" icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, email or user id" />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)} placeholder="Any role" options={ROLE_OPTIONS} />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Any status" options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'BLOCKED', label: 'Blocked' }]} />
        </Field>
        <Button type="submit" variant="outline" icon="filter">Apply filters</Button>
      </FilterBar>
      <DataTable
        caption="Users"
        columns={columns}
        rows={query.data?.items}
        getRowId={(u) => u.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'users', title: 'No users match these filters', description: 'Check the spelling or clear a filter.' }}
        rowActions={(u) => (
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => setDetail(u)}>Details</Button>
            {canBlock && u.id !== auth.user?.id ? (
              <Button size="xs" variant={u.status === 'BLOCKED' ? 'outline' : 'danger-outline'} onClick={() => setTarget({ user: u, block: u.status !== 'BLOCKED' })}>
                {u.status === 'BLOCKED' ? 'Unblock' : 'Block'}
              </Button>
            ) : null}
          </div>
        )}
        footer={
          <Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />
        }
      />

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target?.block ? 'Block this user?' : 'Unblock this user?'}
        description={target ? `${target.user.name || target.user.email || formatPhone(target.user.phone)}${target.block ? ' will be signed out everywhere and cannot sign in.' : ' can sign in again.'}` : undefined}
        confirmLabel={target?.block ? 'Block user' : 'Unblock user'}
        tone={target?.block ? 'danger' : 'default'}
        reason={target?.block ? { label: 'Reason', minLength: 3, options: ['Fraud or abuse', 'Policy violation', 'Requested by the user'] } : undefined}
        onConfirm={(reason) => block.mutateAsync({ user: target!.user, blocked: target!.block, reason })}
      />

      <Dialog open={detail !== null} onClose={() => setDetail(null)} title={detail?.name || detail?.email || 'User'} footer={<FormActions><Button onClick={() => setDetail(null)}>Close</Button></FormActions>}>
        {detail ? (
          <KeyValues
            items={[
              { label: 'User id', value: <Mono>{detail.id}</Mono> },
              { label: 'Status', value: <StatusPill kind="user" status={detail.status} /> },
              { label: 'Phone', value: formatPhone(detail.phone) || '-' },
              { label: 'Email', value: detail.email ?? '-' },
              { label: 'Roles', value: detail.roles.map(humanize).join(', ') },
              { label: 'Admin roles', value: detail.adminRoles.length ? detail.adminRoles.map(humanize).join(', ') : '-' },
              { label: 'Saved addresses', value: String(detail.addresses?.length ?? 0) },
              { label: 'Joined', value: formatDate(detail.createdAt) },
            ]}
          />
        ) : null}
      </Dialog>
      <CreateAdminDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
