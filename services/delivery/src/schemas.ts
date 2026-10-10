/** Request + response schemas (shared by routes and OpenAPI). */
import { z } from 'zod';
import {
  DeliveryStatus,
  EstimateSource,
  OfferStatus,
  PartnerStatus,
  enumValues,
  GeoPointSchema,
  HandoverCodeSchema,
  LocationPingSchema,
  ObjectIdSchema,
  PaginationQuerySchema,
  VehicleSchema,
  VehicleTypeSchema,
} from '@thali/contracts';
import { PARTNER_DOC_TYPES } from './models/partner.js';
import { DOC_CONTENT_TYPES } from './domain/onboarding.js';

// ---------------------------------------------------------------- requests
export const IdParams = z.object({ id: ObjectIdSchema });
export const JobIdParams = z.object({ jobId: ObjectIdSchema });
export const OfferIdParams = z.object({ offerId: ObjectIdSchema });
export const ChildOrderParams = z.object({ childOrderId: z.string().min(1).max(64) });
export const DocParams = z.object({ id: ObjectIdSchema, docId: ObjectIdSchema });

export const DocTypeSchema = z.enum(PARTNER_DOC_TYPES).meta({ id: 'PartnerDocumentType' });
export const CreateProfileBody = z
  .object({ name: z.string().trim().min(2).max(80).optional(), vehicle: VehicleSchema.optional() })
  .meta({ id: 'CreatePartnerProfile', example: { vehicle: { type: 'SCOOTER', registrationNumber: 'KA05MN4321' } } });
export const UpdateProfileBody = z
  .object({ name: z.string().trim().min(2).max(80).optional(), vehicle: VehicleSchema.optional() })
  .refine((v) => v.name !== undefined || v.vehicle !== undefined, { message: 'Nothing to update' })
  .meta({ id: 'UpdatePartnerProfile' });
export const presignBody = (maxBytes: number) =>
  z
    .object({
      type: DocTypeSchema,
      contentType: z.enum(DOC_CONTENT_TYPES),
      /** Client-declared file size; signed into the presigned PUT as Content-Length. */
      sizeBytes: z.number().int().min(1).max(maxBytes),
    })
    .meta({ id: 'PartnerUploadRequest', example: { type: 'ID_PROOF', contentType: 'image/jpeg', sizeBytes: 245_000 } });
export const AttachDocumentBody = z.object({ type: DocTypeSchema, key: z.string().min(10).max(300) }).meta({ id: 'AttachPartnerDocument' });
export const OnlineBody = GeoPointSchema;
export const PingBody = LocationPingSchema;
export const CodeBody = z.object({ code: HandoverCodeSchema }).meta({ id: 'HandoverCode', example: { code: '4821' } });
export const FailBody = z.object({ reason: z.string().trim().min(3).max(500) }).meta({ id: 'FailReason' });
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).meta({ id: 'AdminReason' });
export const OptionalReasonBody = z.object({ reason: z.string().trim().min(3).max(500).optional() }).meta({ id: 'OptionalReason' });
export const AssignBody = z.object({ partnerId: ObjectIdSchema }).meta({ id: 'AssignPartner' });
export const PartnersQuery = PaginationQuerySchema.extend({ status: z.enum(enumValues(PartnerStatus)).optional() });
export const JobsQuery = PaginationQuerySchema.extend({
  q: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('Order code prefix (TH-…: child or checkout code), job id, child order id or checkout group id'),
  status: z.enum(enumValues(DeliveryStatus)).optional(),
  exception: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export const HistoryQuery = PaginationQuerySchema;
export const ContactBody = z
  .object({ target: z.enum(['CUSTOMER', 'RESTAURANT']) })
  .meta({ id: 'ContactRequest', example: { target: 'CUSTOMER' } });

// ---------------------------------------------------------------- responses
const LatLng = GeoPointSchema;
const iso = z.string().nullable();
const Place = z.object({ name: z.string(), address: z.string(), location: LatLng });
const Drop = Place.extend({ phoneMasked: z.string() });
const area = z.string().nullable().describe('Drop locality (falls back to the pincode for older jobs)');
const AdminDrop = Drop.extend({ area, label: z.string().nullable() });
/** DLV-2: address + coordinates are null until the food is picked up (`addressRevealed`). */
const PartnerDrop = z
  .object({
    name: z.string(),
    area,
    label: z.string().nullable().describe('Address label (Home / Work …)'),
    address: z.string().nullable(),
    location: LatLng.nullable(),
    addressRevealed: z.boolean().describe('false before PICKED_UP: only area + label are shared'),
    phoneMasked: z.string(),
  })
  .meta({ id: 'PartnerJobDrop' });
/** DLV-2: an offered (not yet assigned) partner sees only the drop area and its distance from pickup. */
const OfferDrop = z
  .object({ area, distanceFromPickupKm: z.number().describe('pickup → drop distance, rounded to 0.1 km') })
  .meta({ id: 'OfferDrop', example: { area: 'HAL 2nd Stage', distanceFromPickupKm: 3.2 } });

export const PartnerView = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    phone: z.string().nullable(),
    vehicle: z.object({ type: VehicleTypeSchema, registrationNumber: z.string() }).nullable(),
    status: z.enum(enumValues(PartnerStatus)),
    statusReason: z.string().nullable(),
    documents: z.array(z.object({ id: z.string(), type: DocTypeSchema, demoVerified: z.boolean().describe('Demo-mode dummy verification label; never implies approval'), uploadedAt: iso })),
    online: z.boolean(),
    lastLocation: LatLng.nullable(),
    lastLocationAt: iso,
    activeJobIds: z.array(z.string()),
    maxActive: z.number().int(),
    isDemo: z.boolean(),
    createdAt: iso,
  })
  .meta({ id: 'Partner' });

export const PresignResponse = z
  .object({
    key: z.string(),
    upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.string(), maxBytes: z.number() }),
  })
  .meta({ id: 'PartnerUploadTicket' });

export const PartnerJobView = z
  .object({
    id: z.string(),
    childOrderId: z.string(),
    childOrderCode: z.string().nullable().describe('e.g. TH-K7Z2MP4Q (null until backfilled for older jobs)'),
    checkoutCode: z.string().nullable(),
    status: z.enum(enumValues(DeliveryStatus)),
    pickup: Place,
    drop: PartnerDrop,
    distanceKm: z.number(),
    estimatedMinutes: z.number(),
    estimateSource: z.enum(enumValues(EstimateSource)),
    prepMinutes: z.number().nullable(),
    readyEta: iso,
    readyAt: iso,
    codeAttemptsRemaining: z.number().int(),
    navigation: z.object({ pickupUrl: z.string(), dropUrl: z.string().nullable().describe('null until pickup (DLV-2)') }),
    assignedAt: iso,
    pickedUpAt: iso,
    deliveredAt: iso,
    failureReason: z.string().nullable(),
    createdAt: iso,
  })
  .meta({ id: 'PartnerDeliveryJob' });

const History = z.object({ from: z.string().nullable(), to: z.string(), at: iso, actor: z.string(), actorId: z.string().nullable(), reason: z.string().nullable() });
export const AdminJobView = z
  .object({
    id: z.string(),
    childOrderId: z.string(),
    childOrderCode: z.string().nullable().describe('e.g. TH-K7Z2MP4Q (null until backfilled for older jobs)'),
    checkoutCode: z.string().nullable(),
    checkoutGroupId: z.string(),
    restaurantId: z.string(),
    customerUserId: z.string(),
    status: z.enum(enumValues(DeliveryStatus)),
    partnerId: z.string().nullable(),
    partnerUserId: z.string().nullable(),
    pickup: Place,
    drop: AdminDrop,
    dispatchRound: z.number().int(),
    exception: z.boolean(),
    exceptionReason: z.string().nullable(),
    distanceKm: z.number(),
    estimatedMinutes: z.number(),
    estimateSource: z.enum(enumValues(EstimateSource)),
    codeAttempts: z.number().int(),
    readyAt: iso,
    failureReason: z.string().nullable(),
    lastLocation: LatLng.nullable(),
    lastLocationAt: iso,
    locationSimulated: z.boolean(),
    statusHistory: z.array(History),
    assignedAt: iso,
    pickedUpAt: iso,
    deliveredAt: iso,
    createdAt: iso,
  })
  .meta({ id: 'AdminDeliveryJob' });

export const BatchEvaluationSchema = z
  .object({ eligible: z.boolean(), reasons: z.array(z.string()), extraMinutes: z.number() })
  .meta({ id: 'BatchEvaluation', example: { eligible: true, reasons: ['active 1 < max 2 ✓', 'pickup 0.8km ≤ 1.5km ✓', 'drop 2.0km ≤ 3km ✓', 'extra 7.8min ≤ 12min ✓'], extraMinutes: 7.8 } });

export const OfferView = z
  .object({
    id: z.string(),
    jobId: z.string(),
    status: z.enum(enumValues(OfferStatus)),
    round: z.number().int(),
    expiresAt: iso,
    distanceToPickupKm: z.number(),
    batchEvaluation: BatchEvaluationSchema,
    job: z
      .object({ childOrderId: z.string(), pickup: Place, drop: OfferDrop, distanceKm: z.number(), estimatedMinutes: z.number(), estimateSource: z.enum(enumValues(EstimateSource)), readyEta: iso })
      .nullable(),
  })
  .meta({ id: 'DeliveryOffer' });

export const AcceptResponse = z.object({ offerId: z.string(), status: z.literal('ACCEPTED'), job: PartnerJobView }).meta({ id: 'AcceptOfferResult' });
export const PingResponse = z.object({ at: z.string(), jobsUpdated: z.number().int() }).meta({ id: 'LocationPingResult' });

export const TrackingResponse = z
  .object({
    childOrderId: z.string(),
    status: z.enum(enumValues(DeliveryStatus)),
    partner: z.object({ firstName: z.string(), vehicleType: VehicleTypeSchema }).nullable(),
    location: LatLng.nullable(),
    lastLocationAt: iso,
    stale: z.boolean().describe('true when the last location is older than LOCATION_STALE_SEC (60 s)'),
    simulated: z.boolean().describe('true when the location comes from the demo simulator'),
    estimatedMinutes: z.number().describe('Static job estimate (restaurant → drop at job creation)'),
    estimateSource: z.enum(enumValues(EstimateSource)),
    remaining: z
      .object({
        minutes: z.number().int(),
        distanceKm: z.number(),
        source: z.enum(enumValues(EstimateSource)).describe('GOOGLE = estimate; DEMO_HAVERSINE / HAVERSINE_FALLBACK = demo / approximate estimate'),
        computedAt: z.string(),
      })
      .nullable()
      .describe('Live remaining ETA from the rider position (cached 30 s); null before assignment or without a position — fall back to the static estimate'),
  })
  .meta({ id: 'DeliveryTracking' });

export const ContactResponse = z
  .object({
    target: z.enum(['CUSTOMER', 'RESTAURANT']),
    mode: z.enum(['DIRECT', 'PROXY', 'DEMO']).describe('DEMO: no real call (APP_MODE=demo); DIRECT: real number in telUrl (pilot); PROXY: reserved'),
    telUrl: z.string().nullable().describe('tel: URL to dial; null in DEMO mode'),
    displayNumber: z.string().describe('Masked number for display, e.g. "+91 ••••• •3210"'),
    expiresAt: z.string().describe('Do not reuse the number after this time; ask again'),
    note: z.string().nullable().describe('"Calling is simulated in demo" in DEMO mode, else null'),
  })
  .meta({ id: 'ContactResult', example: { target: 'CUSTOMER', mode: 'DEMO', telUrl: null, displayNumber: '+91 ••••• •3210', expiresAt: '2026-10-11T14:10:00.000Z', note: 'Calling is simulated in demo' } });

export const DocumentUrlResponse = z.object({ url: z.string(), expiresAt: z.string(), type: DocTypeSchema, demoVerified: z.boolean() }).meta({ id: 'PartnerDocumentUrl' });
export const OverviewResponse = z
  .object({
    jobsByStatus: z.record(z.string(), z.number()),
    exceptions: z.number().int(),
    liveOffers: z.number().int(),
    partners: z.object({ byStatus: z.record(z.string(), z.number()), online: z.number().int() }),
    generatedAt: z.string(),
  })
  .meta({ id: 'DeliveryOverview' });
export const SimulateResponse = z.object({ jobId: z.string(), steps: z.number().int(), stepMs: z.number().int(), simulated: z.literal(true) }).meta({ id: 'DemoSimulation' });

export const page = <T extends z.ZodType>(item: T, id: string) => z.object({ items: z.array(item), nextCursor: z.string().nullable() }).meta({ id });
export const ItemsOf = <T extends z.ZodType>(item: T, id: string) => z.object({ items: z.array(item) }).meta({ id });
