/**
 * Delivery demo seed (APP_MODE=demo only; idempotent; writes only thali_delivery + KYC placeholders in S3).
 *
 *   container:  docker compose exec delivery node dist/seed.js
 *   local:      npm run seed -w @thali/delivery
 *
 * Partners (`partner:<n>`, userId = seedId(`user:partner<n>`), all isDemo):
 *   1 Arjun Singh  +919200000001  APPROVED, online near Spice Route / Green Leaf (Koramangala)
 *   2 Kiran Das    +919200000002  APPROVED, offline
 *   3 Farhan Ali   +919200000003  APPROVAL_PENDING (documents uploaded, awaiting admin review)
 *   4 Deepak Yadav +919200000004  SUSPENDED
 * Dispatch only considers partners whose last location ping is fresh (DISPATCH_LOCATION_MAX_AGE_SEC), so the
 * online partner's seeded location is a starting point: the partner app (or smoke test) keeps it fresh.
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { demoPdf, ensureDocs, isMainModule, runSeedCli, uploadSeedObjects, type SeedObject, type SeedReport } from '@thali/service-kit/seed';
import { parseDeliveryConfig, type DeliveryConfig } from './config.js';
import { getModels, initDeliveryModels } from './models/index.js';

export type DeliverySeedConfig = Pick<
  DeliveryConfig,
  'MAX_ACTIVE_DELIVERIES' | 'S3_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_PUBLIC_BUCKET' | 'S3_PRIVATE_BUCKET'
>;

const SEEDED_AT = new Date('2026-09-01T05:00:00.000Z');
const DOC_TYPES = ['ID_PROOF', 'DRIVING_LICENSE', 'VEHICLE_RC'] as const;
const docKey = (n: number, type: string) => `partners/demo/partner${n}/${type.toLowerCase()}.pdf`;

interface PartnerSpec {
  n: number;
  name: string;
  phone: string;
  status: 'APPROVED' | 'APPROVAL_PENDING' | 'SUSPENDED';
  online: boolean;
  vehicle: { type: 'BIKE' | 'SCOOTER' | 'BICYCLE' | 'CAR'; registrationNumber: string };
  location?: [lat: number, lng: number];
  statusReason?: string;
}

const PARTNERS: PartnerSpec[] = [
  { n: 1, name: 'Arjun Singh', phone: '+919200000001', status: 'APPROVED', online: true, vehicle: { type: 'BIKE', registrationNumber: 'KA01AB1234' }, location: [12.9345, 77.626] },
  { n: 2, name: 'Kiran Das', phone: '+919200000002', status: 'APPROVED', online: false, vehicle: { type: 'SCOOTER', registrationNumber: 'KA05CD5678' }, location: [12.9301, 77.6202] },
  { n: 3, name: 'Farhan Ali', phone: '+919200000003', status: 'APPROVAL_PENDING', online: false, vehicle: { type: 'BIKE', registrationNumber: 'KA03EF9012' } },
  {
    n: 4, name: 'Deepak Yadav', phone: '+919200000004', status: 'SUSPENDED', online: false, vehicle: { type: 'BICYCLE', registrationNumber: 'NA-BICYCLE-04' },
    statusReason: 'Repeated late deliveries (demo)', location: [12.9255, 77.6301],
  },
];

function partnerDoc(p: PartnerSpec, maxActive: number) {
  const at = (h: number) => new Date(SEEDED_AT.getTime() + h * 3_600_000);
  const userId = seedId(`user:partner${p.n}`);
  const history: Record<string, unknown>[] = [{ from: 'DRAFT', to: 'APPROVAL_PENDING', at: at(0), actor: 'PARTNER', actorId: userId, reason: null }];
  if (p.status !== 'APPROVAL_PENDING') history.push({ from: 'APPROVAL_PENDING', to: 'APPROVED', at: at(1), actor: 'ADMIN', actorId: seedId('user:admin'), reason: 'Demo data' });
  if (p.status === 'SUSPENDED') history.push({ from: 'APPROVED', to: 'SUSPENDED', at: at(48), actor: 'ADMIN', actorId: seedId('user:admin'), reason: p.statusReason ?? null });
  const now = new Date();
  return {
    _id: seedId(`partner:${p.n}`),
    userId,
    name: p.name,
    phone: p.phone,
    vehicle: p.vehicle,
    status: p.status,
    statusReason: p.statusReason ?? null,
    statusHistory: history,
    documents: DOC_TYPES.map((type) => ({
      _id: seedId(`partner-doc:${p.n}:${type}`),
      type,
      key: docKey(p.n, type),
      contentType: 'application/pdf',
      size: null,
      demoVerified: p.status !== 'APPROVAL_PENDING',
      uploadedAt: at(0),
    })),
    online: p.online,
    ...(p.location ? { lastLocation: { type: 'Point', coordinates: [p.location[1], p.location[0]] }, lastLocationAt: p.online ? now : at(2) } : {}),
    activeJobIds: [],
    maxActive,
    isDemo: true,
    createdAt: SEEDED_AT,
    updatedAt: at(p.status === 'SUSPENDED' ? 48 : 1),
  };
}

export async function seedDelivery(conn: Connection, cfg: DeliverySeedConfig): Promise<SeedReport> {
  const { Partner } = getModels(conn);
  const report: SeedReport = {};
  await ensureDocs(Partner, PARTNERS.map((p) => partnerDoc(p, cfg.MAX_ACTIVE_DELIVERIES)), report);

  if (cfg.S3_ENDPOINT || cfg.S3_ACCESS_KEY_ID) {
    const objects: SeedObject[] = PARTNERS.flatMap((p) =>
      DOC_TYPES.map((type) => ({ bucket: cfg.S3_PRIVATE_BUCKET, key: docKey(p.n, type), contentType: 'application/pdf', body: demoPdf(`${p.name} ${type}`) })),
    );
    await uploadSeedObjects(
      {
        ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}),
        region: cfg.S3_REGION,
        ...(cfg.S3_ACCESS_KEY_ID ? { accessKeyId: cfg.S3_ACCESS_KEY_ID } : {}),
        ...(cfg.S3_SECRET_ACCESS_KEY ? { secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } : {}),
        publicBucket: cfg.S3_PUBLIC_BUCKET,
      },
      objects,
      report,
    );
  }
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({
    service: 'delivery',
    dbName: 'thali_delivery',
    init: async (conn) => {
      await initDeliveryModels(conn);
    },
    run: (conn) => seedDelivery(conn, parseDeliveryConfig()),
  });
}
