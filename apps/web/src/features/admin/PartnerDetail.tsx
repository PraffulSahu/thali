/** `/admin/partners/:id`: application review with signed-URL documents and approval actions. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardSection } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { formatDateTime, formatPhone } from '../../lib/format';
import { findPartner, partnerAction, partnerDocumentUrl, qk, type AdminPartner } from './api';
import { ApprovalPanel, DemoBadge, DocumentViewer, KeyValues, SectionTitle, useAdminMutation, useAdminRoles } from './shared';

const DOC_LABELS: Record<string, string> = { ID_PROOF: 'ID proof', DRIVING_LICENSE: 'Driving licence', VEHICLE_RC: 'Vehicle RC', SELFIE: 'Selfie' };

function Documents({ partner }: { partner: AdminPartner }) {
  const [viewing, setViewing] = useState<AdminPartner['documents'][number] | null>(null);
  if (partner.documents.length === 0) return <p className="text-sm text-slate-600">No documents uploaded yet.</p>;
  return (
    <>
      <ul className="divide-y divide-slate-200 rounded-card border border-slate-200">
        {partner.documents.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium text-slate-900">{DOC_LABELS[d.type] ?? humanize(d.type)}</p>
              <p className="text-sm text-slate-600">Uploaded {formatDateTime(d.uploadedAt)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {d.demoVerified ? <DemoBadge label="Demo verified" /> : null}
              <Button size="sm" variant="secondary" icon="external" onClick={() => setViewing(d)}>
                View
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {viewing ? (
        <DocumentViewer
          open
          onClose={() => setViewing(null)}
          title={`${DOC_LABELS[viewing.type] ?? viewing.type} - ${partner.name}`}
          fileHint=""
          load={() => partnerDocumentUrl(partner.id, viewing.id)}
        />
      ) : null}
    </>
  );
}

export default function PartnerDetail() {
  const { id = '' } = useParams();
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.partner(id), queryFn: () => findPartner(id) });
  const act = useAdminMutation(({ action, reason }: { action: Parameters<typeof partnerAction>[1]; reason?: string }) => partnerAction(id, action, reason), {
    success: (_d, v) => `Partner ${{ approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated' }[v.action]}`,
    invalidate: [['admin', 'partner', id], ['admin', 'partners']],
  });

  return (
    <QueryState query={query}>
      {(p) => (
        <>
          <PageHeader
            title={p.name}
            back={{ to: '/admin/partners', label: 'All partners' }}
            status={<StatusPill kind="partner" status={p.status} />}
            description={p.statusReason ? `Latest reason: ${p.statusReason}` : undefined}
            actions={p.isDemo ? <DemoBadge label="Demo partner" /> : undefined}
          />
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader title="Decision" />
              <CardSection>
                <ApprovalPanel entity="partner" name={p.name} status={p.status} canAct={canOps} onAction={(action, reason) => act.mutateAsync({ action, reason })} />
              </CardSection>
            </Card>
            <Card>
              <SectionTitle>Details</SectionTitle>
              <KeyValues
                items={[
                  { label: 'Phone', value: formatPhone(p.phone) || '-' },
                  { label: 'Vehicle', value: p.vehicle ? `${p.vehicle.type}, ${p.vehicle.registrationNumber}` : '-' },
                  { label: 'Availability', value: p.online ? <Badge tone="success">Online</Badge> : <Badge>Offline</Badge> },
                  { label: 'Active deliveries', value: `${p.activeJobIds.length} of ${p.maxActive}` },
                  { label: 'Last seen', value: p.lastLocationAt ? <RelativeTime value={p.lastLocationAt} /> : 'No location yet' },
                  { label: 'Joined', value: formatDateTime(p.createdAt) },
                ]}
              />
            </Card>
            <Card>
              <SectionTitle>Documents</SectionTitle>
              <Documents partner={p} />
            </Card>
          </div>
        </>
      )}
    </QueryState>
  );
}
