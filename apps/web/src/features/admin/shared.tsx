/** Small building blocks shared by the admin pages (kept local to the admin area). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { FormActions } from '../../components/ui/FormActions';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import type { ApprovalAction, SignedUrl } from './api';

/** Admin sub-roles from the token (`adm` claim). The server enforces; this only decides what to offer. */
export function useAdminRoles() {
  const { adminRoles } = useAuth();
  const has = (...roles: string[]) => adminRoles.includes('SUPER_ADMIN') || roles.some((r) => (adminRoles as string[]).includes(r));
  return { adminRoles, isSuper: adminRoles.includes('SUPER_ADMIN'), canOps: has('OPS'), canFinance: has('FINANCE'), canSupport: has('SUPPORT', 'OPS') };
}

/** Run a mutation with a success toast, error toast and query invalidation. */
export function useAdminMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { success: string | ((data: TData, vars: TVars) => string); invalidate?: readonly unknown[][]; errorTitle?: string; onSuccess?: (data: TData, vars: TVars) => void },
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      toast({ title: typeof opts.success === 'function' ? opts.success(data, vars) : opts.success, tone: 'success' });
      await Promise.all((opts.invalidate ?? []).map((queryKey) => qc.invalidateQueries({ queryKey })));
      opts.onSuccess?.(data, vars);
    },
    onError: (e) => toast({ title: opts.errorTitle ?? "That didn't work", description: errorMessage(e), tone: 'danger' }),
  });
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={`break-all font-mono text-[0.8125rem] text-slate-700 ${className ?? ''}`}>{children}</code>;
}

export function KeyValues({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-sm text-slate-600">{it.label}</dt>
          <dd className="break-words text-[0.9375rem] font-medium text-slate-900">{it.value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold text-slate-900">{children}</h2>
      {actions}
    </div>
  );
}

export function StatTile({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <div className={`rounded-card border p-4 ${tone === 'danger' ? 'border-danger-100 bg-danger-50' : tone === 'warn' ? 'border-warn-100 bg-warn-50' : 'border-slate-200 bg-surface'}`}>
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

export function DemoBadge({ label = 'Demo' }: { label?: string }) {
  return <Badge tone="info">{label}</Badge>;
}

export function FilterBar({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) {
  return (
    <form
      role="search"
      className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}

/* ------------------------------------------------------------------ signed-URL document viewer */

function kindOf(name: string): 'image' | 'pdf' | 'other' {
  const ext = name.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

export interface DocumentViewerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Object key / file name; only used to pick image vs PDF preview. */
  fileHint: string;
  /** Requests a fresh short-lived URL (each call is audited server-side). */
  load: () => Promise<SignedUrl>;
}

export function DocumentViewer({ open, onClose, title, fileHint, load }: DocumentViewerProps) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: SignedUrl } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [expired, setExpired] = useState(false);

  const fetchUrl = useCallback(() => {
    setState({ status: 'loading' });
    setExpired(false);
    load().then(
      (data) => setState({ status: 'ready', data }),
      (error) => setState({ status: 'error', error }),
    );
  }, [load]);

  useEffect(() => {
    if (open) fetchUrl();
  }, [open, fetchUrl]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const ms = new Date(state.data.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(() => setExpired(true), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [state]);

  const kind = kindOf(fileHint);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="Opened through a short-lived signed link. Each view is recorded in the audit log."
      size="lg"
      footer={
        <FormActions>
          {state.status === 'ready' ? (
            <Button variant="secondary" icon="refresh" onClick={fetchUrl}>
              Get a fresh link
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </FormActions>
      }
    >
      {state.status === 'loading' ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Requesting a signed link…</span>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      {state.status === 'error' ? <ErrorState compact error={state.error} title="Couldn't open this document" onRetry={fetchUrl} /> : null}
      {state.status === 'ready' ? (
        <div className="flex flex-col gap-3">
          {expired ? (
            <p role="alert" className="rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">
              This link has expired. Use “Get a fresh link”.
            </p>
          ) : (
            <p className="text-sm text-slate-600">Link valid until {formatDateTime(state.data.expiresAt)}.</p>
          )}
          {!expired && kind === 'image' ? <img src={state.data.url} alt={title} className="max-h-[60vh] w-full rounded-control border border-slate-200 object-contain" /> : null}
          {!expired && kind === 'pdf' ? <iframe src={state.data.url} title={title} className="h-[60vh] w-full rounded-control border border-slate-200" /> : null}
          {!expired ? (
            <a href={state.data.url} target="_blank" rel="noopener noreferrer" className="w-fit text-sm font-medium text-brand-700 underline underline-offset-4">
              Open in a new tab
            </a>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ approve / reject / suspend / reinstate */

const REJECT_REASONS = ['Documents unclear or incomplete', 'Details do not match documents', 'Does not meet marketplace requirements'];
const SUSPEND_REASONS = ['Food safety or quality complaints', 'Repeated order failures', 'Suspected fraud', 'Requested by the owner'];

export interface ApprovalPanelProps {
  entity: 'restaurant' | 'partner';
  name: string;
  status: string;
  /** Why Approve is unavailable right now (e.g. business email not verified). */
  approveBlockedReason?: string | null;
  canAct: boolean;
  onAction: (action: ApprovalAction, reason?: string) => Promise<unknown>;
}

export function ApprovalPanel({ entity, name, status, approveBlockedReason, canAct, onAction }: ApprovalPanelProps) {
  const [dialog, setDialog] = useState<ApprovalAction | null>(null);
  const what = entity === 'restaurant' ? 'restaurant' : 'delivery partner';
  const none = !['APPROVAL_PENDING', 'APPROVED', 'SUSPENDED'].includes(status);

  if (none) {
    return <p className="text-sm text-slate-600">No action available while the status is {status.toLowerCase().replace(/_/g, ' ')}.</p>;
  }
  if (!canAct) {
    return <p className="text-sm text-slate-600">Your admin role can view this {what} but not change its status. Ask an OPS or super admin.</p>;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {status === 'APPROVAL_PENDING' ? (
          <>
            <Button icon="check" onClick={() => setDialog('approve')} disabled={Boolean(approveBlockedReason)}>
              Approve
            </Button>
            <Button variant="danger" icon="x" onClick={() => setDialog('reject')}>
              Reject
            </Button>
          </>
        ) : null}
        {status === 'APPROVED' ? (
          <Button variant="danger" onClick={() => setDialog('suspend')}>
            Suspend
          </Button>
        ) : null}
        {status === 'SUSPENDED' ? <Button onClick={() => setDialog('reinstate')}>Reinstate</Button> : null}
      </div>
      {approveBlockedReason && status === 'APPROVAL_PENDING' ? <p className="mt-2 text-sm text-warn-800">{approveBlockedReason}</p> : null}

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title={`Approve ${name}?`}
        description={`The ${what} goes live and the owner is notified.`}
        confirmLabel="Approve"
        onConfirm={() => onAction('approve')}
      />
      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title={`Reject ${name}?`}
        description="The reason is sent to the applicant and recorded in the audit log."
        confirmLabel="Reject"
        tone="danger"
        reason={{ label: 'Reason', options: REJECT_REASONS, minLength: 3 }}
        onConfirm={(reason) => onAction('reject', reason)}
      />
      <ConfirmDialog
        open={dialog === 'suspend'}
        onClose={() => setDialog(null)}
        title={`Suspend ${name}?`}
        description={entity === 'restaurant' ? 'The restaurant disappears from discovery and stops receiving orders.' : 'The partner goes offline and stops receiving offers.'}
        confirmLabel="Suspend"
        tone="danger"
        reason={{ label: 'Reason', options: SUSPEND_REASONS, minLength: 3 }}
        onConfirm={(reason) => onAction('suspend', reason)}
      />
      <ConfirmDialog
        open={dialog === 'reinstate'}
        onClose={() => setDialog(null)}
        title={`Reinstate ${name}?`}
        description={`The ${what} is approved again.`}
        confirmLabel="Reinstate"
        onConfirm={() => onAction('reinstate')}
      />
    </>
  );
}
