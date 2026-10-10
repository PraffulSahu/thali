/** `/admin/restaurants/:id`: full application review with signed-URL documents and approval actions. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardSection } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatBps, formatDateTime, formatPhone } from '../../lib/format';
import { getRestaurant, qk, restaurantAction, restaurantDocumentUrl, verifyRestaurantDocument, type AdminRestaurant, type AdminRestaurantDoc } from './api';
import { ApprovalPanel, DemoBadge, DocumentViewer, KeyValues, SectionTitle, useAdminMutation, useAdminRoles } from './shared';

const DOC_LABELS: Record<string, string> = { FSSAI: 'FSSAI licence', GST: 'GST certificate', PAN: 'PAN', BANK_PROOF: 'Bank proof', MENU: 'Menu' };

function Documents({ restaurant }: { restaurant: AdminRestaurant }) {
  const [viewing, setViewing] = useState<AdminRestaurantDoc | null>(null);
  const { canOps } = useAdminRoles();
  const verify = useAdminMutation((docId: string) => verifyRestaurantDocument(restaurant.id, docId), {
    success: 'Document marked as verified',
    invalidate: [['admin', 'restaurant', restaurant.id]],
  });
  if (restaurant.documents.length === 0) return <p className="text-sm text-slate-600">No documents uploaded yet.</p>;
  return (
    <>
      <ul className="divide-y divide-slate-200 rounded-card border border-slate-200">
        {restaurant.documents.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-slate-900">{DOC_LABELS[d.type] ?? d.type}</p>
              <p className="text-sm text-slate-600">Uploaded {formatDateTime(d.uploadedAt)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {d.verified ? <Badge tone="success" icon="check">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
              <Button size="sm" variant="secondary" icon="external" onClick={() => setViewing(d)}>
                View
              </Button>
              {!d.verified && canOps ? (
                <Button size="sm" variant="secondary" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>
                  Mark verified
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {viewing ? (
        <DocumentViewer
          open
          onClose={() => setViewing(null)}
          title={`${DOC_LABELS[viewing.type] ?? viewing.type} - ${restaurant.name}`}
          fileHint={viewing.key}
          load={() => restaurantDocumentUrl(restaurant.id, viewing.id)}
        />
      ) : null}
    </>
  );
}

export default function RestaurantDetail() {
  const { id = '' } = useParams();
  const { canOps } = useAdminRoles();
  const query = useQuery({ queryKey: qk.restaurant(id), queryFn: () => getRestaurant(id) });
  const act = useAdminMutation(({ action, reason }: { action: Parameters<typeof restaurantAction>[1]; reason?: string }) => restaurantAction(id, action, reason), {
    success: (_d, v) => `Restaurant ${{ approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'reinstated' }[v.action]}`,
    invalidate: [['admin', 'restaurant', id], ['admin', 'restaurants']],
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
            actions={r.isDemo ? <DemoBadge label="Demo restaurant" /> : undefined}
          />
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader title="Decision" description="Approval requires a verified business email." />
              <CardSection>
                <ApprovalPanel
                  entity="restaurant"
                  name={r.name}
                  status={r.status}
                  canAct={canOps}
                  approveBlockedReason={!r.emailVerified ? 'The business email has not been verified yet, so this restaurant cannot be approved.' : null}
                  onAction={(action, reason) => act.mutateAsync({ action, reason })}
                />
              </CardSection>
            </Card>

            <Card>
              <SectionTitle>Business details</SectionTitle>
              <KeyValues
                items={[
                  { label: 'Business name', value: r.businessName },
                  { label: 'Cuisines', value: r.cuisines.join(', ') || '-' },
                  { label: 'Business email', value: <>{r.businessEmail ?? '-'} {r.emailVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}</> },
                  { label: 'Phone', value: formatPhone(r.phone) || '-' },
                  { label: 'Address', value: r.address ? [r.address.line1, r.address.line2, r.address.city, r.address.pincode].filter(Boolean).join(', ') : '-' },
                  { label: 'Commission', value: formatBps(r.commissionBps) },
                  { label: 'Settlement account', value: r.settlement ? `${r.settlement.accountHolder}, ${r.settlement.ifsc}, ending ${r.settlement.last4}` : 'Not provided' },
                  { label: 'Created', value: formatDateTime(r.createdAt) },
                ]}
              />
            </Card>

            <Card>
              <SectionTitle>Documents</SectionTitle>
              <Documents restaurant={r} />
            </Card>

            <Card>
              <SectionTitle>Status history</SectionTitle>
              {r.statusHistory.length === 0 ? (
                <p className="text-sm text-slate-600">No changes recorded.</p>
              ) : (
                <ol aria-label="Status history" className="flex flex-col gap-3">
                  {[...r.statusHistory].reverse().map((h, i) => (
                    <li key={i} className="text-[0.9375rem]">
                      <span className="font-medium">{h.from} to {h.to}</span>
                      <span className="text-slate-600"> · {formatDateTime(h.at)} · by {h.actorId}</span>
                      {h.reason ? <p className="text-sm text-slate-700">Reason: {h.reason}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </>
      )}
    </QueryState>
  );
}
