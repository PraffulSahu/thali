/** `/admin/restaurants/:id`: full application review with signed-URL documents and approval actions. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonLink } from '../../components/ui/Button';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill, statusLabel } from '../../components/ui/StatusPill';
import { formatBps, formatDateTime, formatPhone } from '../../lib/format';
import { getRestaurant, qk, restaurantAction, restaurantDocumentUrl, verifyRestaurantDocument, type AdminRestaurant, type AdminRestaurantDoc } from './api';
import { APPROVE_BLOCKED_COPY, ApprovalPanel, DocumentViewer, KeyValues, Mono, useAdminMutation, useAdminRoles } from './shared';
import { DemoTag, DetailColumns, DocRow, HistoryTimeline } from './ui';

const DOC_LABELS: Record<string, string> = { FSSAI: 'FSSAI licence', GST: 'GST certificate', PAN: 'PAN', BANK_PROOF: 'Bank proof', MENU: 'Menu' };

function Documents({ restaurant }: { restaurant: AdminRestaurant }) {
  const [viewing, setViewing] = useState<AdminRestaurantDoc | null>(null);
  const { canOps } = useAdminRoles();
  const verify = useAdminMutation((docId: string) => verifyRestaurantDocument(restaurant.id, docId), {
    success: 'Document marked as verified',
    invalidate: [['admin', 'restaurant', restaurant.id]],
  });
  const verified = restaurant.documents.filter((d) => d.verified).length;
  return (
    <SectionCard title="Documents" meta={restaurant.documents.length ? `${verified}/${restaurant.documents.length} verified` : undefined}>
      {restaurant.documents.length === 0 ? (
        <p className="px-4 py-4 text-[13.5px] text-fg-3">No documents uploaded yet.</p>
      ) : (
        <ul>
          {restaurant.documents.map((d) => (
            <DocRow
              key={d.id}
              title={DOC_LABELS[d.type] ?? d.type}
              sub={`Uploaded ${formatDateTime(d.uploadedAt) || '—'}`}
              chips={d.verified ? <Badge tone="ok" icon="check" density="dense">Verified</Badge> : <Badge tone="warn" density="dense">Not verified</Badge>}
              actions={
                <>
                  <Button size="xs" variant="outline" icon="external" onClick={() => setViewing(d)}>
                    Open
                  </Button>
                  {!d.verified && canOps ? (
                    <Button size="xs" variant="outline" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>
                      Verify
                    </Button>
                  ) : null}
                </>
              }
            />
          ))}
        </ul>
      )}
      {viewing ? (
        <DocumentViewer
          open
          onClose={() => setViewing(null)}
          title={`${DOC_LABELS[viewing.type] ?? viewing.type} · ${restaurant.name}`}
          fileHint={viewing.key}
          load={() => restaurantDocumentUrl(restaurant.id, viewing.id)}
        />
      ) : null}
    </SectionCard>
  );
}

export default function RestaurantDetail() {
  const { id = '' } = useParams();
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.restaurant(id), queryFn: () => getRestaurant(id) });
  const act = useAdminMutation(({ action, reason }: { action: Parameters<typeof restaurantAction>[1]; reason?: string }) => restaurantAction(id, action, reason), {
    success: (_d, v) => `Restaurant ${{ approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated' }[v.action]}`,
    invalidate: [['admin', 'restaurant', id], ['admin', 'restaurants'], ['admin', 'overview', 'marketplace']],
  });

  return (
    <QueryState query={query}>
      {(r) => (
        <>
          <PageHeader
            title={r.name}
            back={{ to: '/admin/restaurants', label: 'All restaurants' }}
            status={<StatusPill kind="restaurant" status={r.status} />}
            description={r.statusReason ? `Latest reason: ${r.statusReason}` : undefined}
            actions={
              <>
                {r.isDemo ? <DemoTag>DEMO RESTAURANT</DemoTag> : null}
                <ButtonLink to={`/admin/orders?restaurantId=${encodeURIComponent(r.id)}`} variant="outline" size="sm" icon="receipt">
                  View orders
                </ButtonLink>
              </>
            }
          />
          <DetailColumns
            main={
              <>
                <SectionCard title="Business details" bodyClassName="px-4 py-4">
                  <KeyValues
                    items={[
                      { label: 'Business name', value: r.businessName },
                      { label: 'Cuisines', value: r.cuisines.join(', ') || '—' },
                      {
                        label: 'Business email',
                        value: (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            {r.businessEmail ?? '—'} {r.emailVerified ? <Badge tone="ok" density="dense">Verified</Badge> : <Badge tone="warn" density="dense">Not verified</Badge>}
                          </span>
                        ),
                      },
                      { label: 'Phone', value: <span className="font-mono text-[13px]">{formatPhone(r.phone) || '—'}</span> },
                      { label: 'Address', value: r.address ? [r.address.line1, r.address.line2, r.address.city, r.address.pincode].filter(Boolean).join(', ') : '—' },
                      { label: 'Commission', value: formatBps(r.commissionBps) },
                      { label: 'Average prep', value: `${r.avgPrepMinutes} min` },
                      { label: 'Settlement account', value: r.settlement ? `${r.settlement.accountHolder}, ${r.settlement.ifsc}, ending ${r.settlement.last4}` : 'Not provided' },
                      { label: 'Created', value: formatDateTime(r.createdAt) },
                    ]}
                  />
                </SectionCard>
                <Documents restaurant={r} />
              </>
            }
            aside={
              <>
                <SectionCard title="Decision" bodyClassName="flex flex-col gap-2 px-4 py-4">
                  <p className="text-[13px] text-fg-3">Approval requires a verified business email.</p>
                  <ApprovalPanel
                    entity="restaurant"
                    name={r.name}
                    status={r.status}
                    canAct={canOps}
                    approveBlockedReason={!r.emailVerified ? APPROVE_BLOCKED_COPY : null}
                    onAction={(action, reason) => act.mutateAsync({ action, reason })}
                  />
                </SectionCard>
                <SectionCard title="Status history" count={r.statusHistory.length} bodyClassName="px-4 py-4">
                  <HistoryTimeline
                    items={[...r.statusHistory].reverse().map((h) => ({
                      title: `${statusLabel('restaurant', h.from)} → ${statusLabel('restaurant', h.to)}`,
                      at: h.at,
                      detail: (
                        <>
                          {h.reason ? `Reason: ${h.reason} · ` : ''}by <Mono className="text-[11.5px]">{h.actorId}</Mono>
                        </>
                      ),
                    }))}
                  />
                </SectionCard>
              </>
            }
          />
        </>
      )}
    </QueryState>
  );
}
