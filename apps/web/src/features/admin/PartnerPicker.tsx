/**
 * Assign / reassign a delivery (board 40 "Assign", TMS). DLV-7 picker: `GET /admin/delivery/partners?status=APPROVED
 * &online=true&hasCapacity=true&nearJobId=<job>` → nearest first with straight-line `distanceToPickupKm`, then
 * `POST /admin/delivery/jobs/:id/assign {partnerId}`. Partners without a known location are not listed (server rule).
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { FormActions } from '../../components/ui/FormActions';
import { QueryState } from '../../components/ui/QueryState';
import { RadioGroup } from '../../components/ui/Radio';
import { formatRelative } from '../../lib/format';
import { assignJob, listPartners, qk, type AdminJob, type AdminPartnerRow } from './api';
import { useAdminMutation } from './shared';

export function jobLabel(job: Pick<AdminJob, 'id' | 'childOrderCode' | 'checkoutCode'>): string {
  return job.childOrderCode ?? job.checkoutCode ?? `Delivery …${job.id.slice(-6)}`;
}

function distance(p: AdminPartnerRow): string | null {
  return typeof p.distanceToPickupKm === 'number' ? `${p.distanceToPickupKm < 10 ? p.distanceToPickupKm.toFixed(1) : Math.round(p.distanceToPickupKm)} km` : null;
}

export function PartnerPicker({ job, onClose }: { job: AdminJob | null; onClose: () => void }) {
  const open = job !== null;
  const [partnerId, setPartnerId] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setPartnerId('');
    setError(null);
  }, [job?.id]);

  const partners = useQuery({
    queryKey: qk.picker(job?.id ?? ''),
    queryFn: () => listPartners({ status: 'APPROVED', online: true, hasCapacity: true, nearJobId: job!.id, limit: 20 }),
    enabled: open,
    staleTime: 0,
  });
  const assign = useAdminMutation((v: { jobId: string; partnerId: string }) => assignJob(v.jobId, v.partnerId), {
    success: () => (job?.partnerId ? 'Delivery reassigned' : 'Partner assigned'),
    invalidate: [['admin', 'tms'], ['admin', 'partners'], ['admin', 'checkouts']],
  });

  const rows = (partners.data?.items ?? []).filter((p) => p.id !== job?.partnerId);

  const submit = async () => {
    if (!job || !partnerId) return;
    setError(null);
    try {
      await assign.mutateAsync({ jobId: job.id, partnerId });
      onClose();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={job?.partnerId ? 'Reassign delivery' : 'Assign a partner'}
      description={job ? `${jobLabel(job)} · pickup at ${job.pickup.name}${job.drop.area ? ` · drop in ${job.drop.area}` : ''}` : undefined}
      footer={
        <FormActions>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!partnerId} loading={assign.isPending}>
            {job?.partnerId ? 'Reassign' : 'Assign'}
          </Button>
        </FormActions>
      }
    >
      <QueryState
        query={partners}
        errorTitle="Couldn't load nearby partners"
        isEmpty={(d) => d.items.filter((p) => p.id !== job?.partnerId).length === 0}
        empty={{
          icon: 'bike',
          title: 'No online partner with spare capacity near this pickup',
          description: 'Only approved, online partners below their delivery limit with a recent location are listed. Try again in a minute.',
          compact: true,
        }}
      >
        {() => (
          <div className="flex flex-col gap-3">
            <RadioGroup
              legend="Nearest available partners"
              name="partner"
              variant="cards"
              value={partnerId}
              onChange={setPartnerId}
              hint="Online, approved and under their delivery limit · straight-line distance to the pickup."
              options={rows.map((p) => ({
                value: p.id,
                label: p.name,
                description: (
                  <span className="text-[12.5px] text-fg-3">
                    {p.vehicle ? `${p.vehicle.type.charAt(0)}${p.vehicle.type.slice(1).toLowerCase()} · ` : ''}
                    {p.activeJobCount ?? p.activeJobIds.length}/{p.maxActive} deliveries
                    {p.lastLocationAt ? ` · seen ${formatRelative(p.lastLocationAt)}` : ''}
                  </span>
                ),
                aside: distance(p) ? (
                  <span className="font-mono text-[13px] text-fg">{distance(p)}</span>
                ) : (
                  <Badge tone="neu" density="dense">
                    No distance
                  </Badge>
                ),
              }))}
            />
            <InlineError error={error} />
          </div>
        )}
      </QueryState>
    </Dialog>
  );
}
