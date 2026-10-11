/** `/admin/partners/:id`: application review with signed-URL documents and approval actions (two-column detail). */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { formatDateTime, formatPhone } from '../../lib/format';
import { findPartner, partnerAction, partnerDocumentUrl, qk, type AdminPartner } from './api';
import { ApprovalPanel, DocumentViewer, KeyValues, useAdminMutation, useAdminRoles } from './shared';
import { DemoTag, DetailColumns, DocRow } from './ui';

const DOC_LABELS: Record<string, string> = { ID_PROOF: 'ID proof', DRIVING_LICENSE: 'Driving licence', VEHICLE_RC: 'Vehicle RC', SELFIE: 'Selfie' };

function Documents({ partner }: { partner: AdminPartner }) {
  const [viewing, setViewing] = useState<AdminPartner['documents'][number] | null>(null);
  return (
    <SectionCard title="Documents" count={partner.documents.length}>
      {partner.documents.length === 0 ? (
        <p className="px-4 py-4 text-[13.5px] text-fg-3">No documents uploaded yet.</p>
      ) : (
        <ul>
          {partner.documents.map((d) => (
            <DocRow
              key={d.id}
              title={DOC_LABELS[d.type] ?? humanize(d.type)}
              sub={`Uploaded ${formatDateTime(d.uploadedAt) || '—'}`}
              chips={d.demoVerified ? <DemoTag>DEMO VERIFIED</DemoTag> : null}
              actions={
                <Button size="xs" variant="outline" icon="external" onClick={() => setViewing(d)}>
                  Open
                </Button>
              }
            />
          ))}
        </ul>
      )}
      {viewing ? (
        <DocumentViewer
          open
          onClose={() => setViewing(null)}
          title={`${DOC_LABELS[viewing.type] ?? viewing.type} · ${partner.name}`}
          fileHint=""
          load={() => partnerDocumentUrl(partner.id, viewing.id)}
        />
      ) : null}
    </SectionCard>
  );
}

export default function PartnerDetail() {
  const { id = '' } = useParams();
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.partner(id), queryFn: () => findPartner(id) });
  const act = useAdminMutation(({ action, reason }: { action: Parameters<typeof partnerAction>[1]; reason?: string }) => partnerAction(id, action, reason), {
    success: (_d, v) => `Partner ${{ approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated' }[v.action]}`,
    invalidate: [['admin', 'partner', id], ['admin', 'partners'], ['admin', 'tms', 'overview']],
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
            actions={p.isDemo ? <DemoTag>DEMO PARTNER</DemoTag> : undefined}
          />
          <DetailColumns
            main={
              <>
                <SectionCard title="Details" bodyClassName="px-4 py-4">
                  <KeyValues
                    items={[
                      { label: 'Phone', value: <span className="font-mono text-[13px]">{formatPhone(p.phone) || '—'}</span> },
                      { label: 'Vehicle', value: p.vehicle ? <span>{humanize(p.vehicle.type)} <span className="font-mono text-[12.5px] text-fg-3">{p.vehicle.registrationNumber}</span></span> : '—' },
                      { label: 'Availability', value: p.online ? <Badge tone="ok" density="dense" dot>Online</Badge> : <Badge density="dense">Offline</Badge> },
                      { label: 'Active deliveries', value: `${p.activeJobIds.length} of ${p.maxActive}` },
                      { label: 'Last location', value: p.lastLocationAt ? <RelativeTime value={p.lastLocationAt} /> : 'No location yet' },
                      { label: 'Joined', value: formatDateTime(p.createdAt) },
                    ]}
                  />
                </SectionCard>
                <Documents partner={p} />
              </>
            }
            aside={
              <SectionCard title="Decision" bodyClassName="px-4 py-4">
                <ApprovalPanel entity="partner" name={p.name} status={p.status} canAct={canOps} onAction={(action, reason) => act.mutateAsync({ action, reason })} />
              </SectionCard>
            }
          />
        </>
      )}
    </QueryState>
  );
}
