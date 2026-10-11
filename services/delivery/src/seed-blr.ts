/**
 * Delivery slice of the Bengaluru dataset (`@thali/contracts/seed-blr`), bulk + idempotent:
 *  - 250 partners (`blr:partner:<k>`, userId `blr:user:partner:<k>`): vehicle + Karnataka plate, mostly APPROVED,
 *    some APPROVAL_PENDING / SUSPENDED / REJECTED; all offline with no location (dispatch never picks them),
 *    KYC documents pointing at 3 shared demo PDFs
 *  - a DELIVERED job for every delivered child order (partner, hashed handover codes, distance, history,
 *    `childOrderCode` / `checkoutCode`, `drop.area` = locality, `drop.label`, `pickup.phone`)
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { BLR_PARTNER_DOC_TYPES, blrMaskPhone, blrPartnerDocKey, type BlrPartner, type BlrWorld } from '@thali/contracts/seed-blr';
import { demoPdf, ensureDocsBulk, uploadSeedObjects, type SeedReport } from '@thali/service-kit/seed';
import type { DeliverySeedConfig } from './seed.js';
import { hashCode } from './domain/codes.js';
import { getModels } from './models/index.js';

const ADMIN = seedId('user:admin');
const pt = (p: { lat: number; lng: number }) => ({ type: 'Point', coordinates: [p.lng, p.lat] });

function partnerDoc(w: BlrWorld, p: BlrPartner, maxActive: number) {
  const created = w.daysAgo(p.createdDaysAgo, -p.k);
  const at = (h: number) => new Date(created.getTime() + h * 3_600_000);
  const history: Record<string, unknown>[] = [{ from: 'DRAFT', to: 'APPROVAL_PENDING', at: at(0.5), actor: 'PARTNER', actorId: p.id, reason: null }];
  if (p.status === 'APPROVED' || p.status === 'SUSPENDED') history.push({ from: 'APPROVAL_PENDING', to: 'APPROVED', at: at(26), actor: 'ADMIN', actorId: ADMIN, reason: 'Documents verified' });
  if (p.status === 'SUSPENDED') history.push({ from: 'APPROVED', to: 'SUSPENDED', at: w.daysAgo(2 + (p.k % 9)), actor: 'ADMIN', actorId: ADMIN, reason: p.statusReason });
  if (p.status === 'REJECTED') history.push({ from: 'APPROVAL_PENDING', to: 'REJECTED', at: at(30), actor: 'ADMIN', actorId: ADMIN, reason: p.statusReason });
  return {
    _id: p.partnerId,
    userId: p.id,
    name: p.name,
    phone: p.phone,
    vehicle: p.vehicle,
    status: p.status,
    statusReason: p.statusReason,
    statusHistory: history,
    documents: BLR_PARTNER_DOC_TYPES.map((type) => ({
      _id: seedId(`blr:partner-doc:${p.k}:${type}`),
      type,
      key: blrPartnerDocKey(type),
      contentType: 'application/pdf',
      size: null,
      demoVerified: p.status === 'APPROVED' || p.status === 'SUSPENDED',
      uploadedAt: at(0.4),
    })),
    online: false,
    activeJobIds: [],
    maxActive,
    isDemo: true,
    createdAt: created,
    updatedAt: history[history.length - 1]!.at as Date,
  };
}

export async function seedDeliveryBlr(conn: Connection, w: BlrWorld, cfg: DeliverySeedConfig): Promise<SeedReport> {
  const { Partner, Job } = getModels(conn);
  const report: SeedReport = {};
  const sfx = ' (blr)';
  await ensureDocsBulk(Partner, w.partners.map((p) => partnerDoc(w, p, cfg.MAX_ACTIVE_DELIVERIES)), report, { label: `partners${sfx}` });

  await ensureDocsBulk(Job, (function* () {
    for (const co of w.checkouts) {
      for (const ch of co.children) {
        if (ch.outcome.kind !== 'DELIVERED') continue;
        const t = ch.timeline;
        const p = ch.partner!;
        const r = ch.restaurant;
        const h = (from: string | null, to: string, at: Date, actor: string, actorId: string | null = null, reason: string | null = null) => ({ from, to, at, actor, actorId, reason });
        const a = co.address;
        yield {
          _id: seedId(`blr:delivery-job:${co.n}:${ch.c}`),
          childOrderId: ch.id,
          checkoutGroupId: co.id,
          restaurantId: r.id,
          customerUserId: co.consumer.id,
          childOrderCode: ch.code,
          checkoutCode: co.code,
          codesCheckedAt: t.acceptedAt,
          pickup: { name: r.name, address: `${r.address.line1}, ${r.address.locality}, ${r.address.city} ${r.address.pincode}`, location: pt(r.location), phone: r.phone },
          drop: {
            name: co.consumer.name,
            address: `${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.locality}, ${a.city} ${a.pincode}`,
            location: pt(a.location),
            phoneMasked: blrMaskPhone(co.consumer.phone),
            area: a.locality,
            label: a.label,
          },
          status: 'DELIVERED',
          partnerId: p.partnerId,
          partnerUserId: p.id,
          dispatchRound: 1,
          distanceKm: ch.distanceKm,
          estimatedMinutes: ch.etaMinutes,
          estimateSource: 'DEMO_HAVERSINE',
          prepMinutes: ch.prepMinutes,
          readyEta: new Date(t.acceptedAt!.getTime() + ch.prepMinutes * 60_000),
          readyAt: t.readyAt,
          pickupCodeHash: hashCode(ch.id, ch.pickupCode),
          deliveryCodeHash: hashCode(ch.id, ch.deliveryCode),
          statusHistory: [
            h(null, 'PENDING_ASSIGNMENT', t.acceptedAt!, 'SYSTEM', null, 'order.accepted'),
            h('PENDING_ASSIGNMENT', 'OFFERED', t.acceptedAt!, 'SYSTEM'),
            h('OFFERED', 'ASSIGNED', t.assignedAt!, 'PARTNER', p.id),
            h('ASSIGNED', 'AT_PICKUP', t.atPickupAt!, 'PARTNER', p.id),
            h('AT_PICKUP', 'PICKED_UP', t.pickedUpAt!, 'PARTNER', p.id),
            h('PICKED_UP', 'OUT_FOR_DELIVERY', t.outForDeliveryAt!, 'PARTNER', p.id),
            h('OUT_FOR_DELIVERY', 'DELIVERED', t.deliveredAt!, 'PARTNER', p.id),
          ],
          lastLocation: pt(a.location),
          lastLocationAt: t.deliveredAt,
          locationSimulated: true,
          isDemo: true,
          assignedAt: t.assignedAt,
          pickedUpAt: t.pickedUpAt,
          deliveredAt: t.deliveredAt,
          createdAt: t.acceptedAt,
          updatedAt: t.deliveredAt,
        };
      }
    }
  })(), report, { label: `delivery_jobs${sfx}` });

  if (cfg.S3_ENDPOINT || cfg.S3_ACCESS_KEY_ID) {
    await uploadSeedObjects(
      {
        ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}),
        region: cfg.S3_REGION,
        ...(cfg.S3_ACCESS_KEY_ID ? { accessKeyId: cfg.S3_ACCESS_KEY_ID } : {}),
        ...(cfg.S3_SECRET_ACCESS_KEY ? { secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : {}),
        publicBucket: cfg.S3_PUBLIC_BUCKET,
      },
      BLR_PARTNER_DOC_TYPES.map((type) => ({ bucket: cfg.S3_PRIVATE_BUCKET, key: blrPartnerDocKey(type), contentType: 'application/pdf', body: demoPdf(`Demo partner ${type}`) })),
      report,
      `objects (S3)${sfx}`,
    );
  }
  return report;
}
