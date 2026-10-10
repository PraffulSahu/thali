/**
 * OpenAPI registry for the notifications service (every route, request/response schema, security, errors)
 * plus the shared request/response schemas the route handlers validate with.
 */
import { z } from 'zod';
import {
  NotificationChannel,
  NotificationStatus,
  ObjectIdSchema,
  OtpCodeSchema,
  PaginationQuerySchema,
  PhoneSchema,
  enumValues,
  paginatedSchema,
} from '@thali/contracts';
import { DeadLetterViewSchema, createOpenApi, registerOpsRoutes } from '@thali/service-kit';
import { TEMPLATE_NAMES } from './domain/templates.js';

export const openapi = createOpenApi('notifications', {
  title: 'Thali Notifications API',
  description: 'SMS / email / in-app notifications, provider webhooks, and the SSE realtime hub.',
});

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

// ---------- schemas ----------
export const ChannelSchema = z.enum(enumValues(NotificationChannel));
/** Contracts' NotificationStatus (incl. terminal `SKIPPED`: opted out / blocked / no address / unknown user). */
export const StatusSchema = z.enum(enumValues(NotificationStatus));

export const InAppNotificationView = z
  .object({
    id: ObjectIdSchema,
    template: z.string(),
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.unknown()),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'InAppNotification' });

export const InAppListQuery = PaginationQuerySchema.extend({ unread: z.enum(['true', 'false']).optional() });
export const InAppListResponse = paginatedSchema(InAppNotificationView).extend({ unreadCount: z.number().int() }).meta({ id: 'InAppNotificationPage' });
export const IdParams = z.object({ id: ObjectIdSchema });

export const TicketResponse = z.object({ ticket: z.string(), expiresInSec: z.literal(30) }).meta({ id: 'RealtimeTicket' });
export const StreamQuery = z.object({ ticket: z.string().min(16).max(256) });

export const OtpBody = z.object({ phone: PhoneSchema, code: OtpCodeSchema }).meta({ id: 'InternalOtpRequest' });
export const SendBody = z
  .object({
    channel: ChannelSchema,
    to: z.string().min(3).max(254).optional(),
    userId: ObjectIdSchema.optional(),
    template: z.string().min(1).max(64).describe(`One of: ${TEMPLATE_NAMES.join(', ')}`),
    data: z.record(z.string(), z.unknown()).default({}),
    dedupeKey: z.string().regex(/^[\x21-\x7E]{8,200}$/, '8-200 printable characters, no spaces'),
  })
  .meta({ id: 'InternalSendRequest' });
export const NotificationIdResponse = z.object({ notificationId: ObjectIdSchema }).meta({ id: 'NotificationId' });

export const AdminNotificationView = z
  .object({
    id: ObjectIdSchema,
    userId: z.string().nullable(),
    audience: z.string().nullable(),
    channel: ChannelSchema,
    to: z.string().describe('Masked'),
    template: z.string(),
    status: StatusSchema,
    attempts: z.number().int(),
    nextAttemptAt: z.string().nullable(),
    provider: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    lastError: z.string().nullable(),
    skipReason: z.string().nullable(),
    sourceEventId: z.string().nullable(),
    dedupeKey: z.string(),
    readAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'AdminNotification' });
export const AdminListQuery = PaginationQuerySchema.extend({ status: StatusSchema.optional(), channel: ChannelSchema.optional(), userId: ObjectIdSchema.optional() });
export const AdminListResponse = paginatedSchema(AdminNotificationView).meta({ id: 'AdminNotificationPage' });

// NTF-1 / NTF-2
export const NotificationSummaryResponse = z
  .object({
    byStatus: z.record(StatusSchema, z.number().int()).describe('All-time counts, every status present (0 when none)'),
    failedLast24h: z.number().int().describe('FAILED + DEAD notifications last updated (i.e. last failed) in the past 24 hours'),
    byChannel: z
      .object({ SMS: z.object({ failed: z.number().int() }), EMAIL: z.object({ failed: z.number().int() }) })
      .describe('FAILED + DEAD notifications updated in the past 24 hours, per channel'),
    lastError: z
      .object({ channel: ChannelSchema, provider: z.string().nullable(), message: z.string(), at: z.string() })
      .nullable()
      .describe('Most recent error on a FAILED/DEAD notification; message scrubbed of addresses, numbers and secrets'),
  })
  .meta({ id: 'NotificationSummary' });
export const BulkRetryBody = z
  .object({
    status: z.enum(['FAILED', 'DEAD']),
    channel: ChannelSchema.optional(),
    before: z.iso.datetime({ offset: true }).pipe(z.coerce.date()).optional().describe('Only notifications created before this instant'),
    limit: z.number().int().min(1).max(500).default(500),
  })
  .strict()
  .meta({ id: 'BulkRetryRequest' });
export const BulkRetryResponse = z.object({ queued: z.number().int() }).meta({ id: 'BulkRetryResult' });

// NTF-3
export const BulkReplayBody = z
  .object({ service: z.string().min(1).max(32).optional(), limit: z.number().int().min(1).max(100).default(100) })
  .strict()
  .meta({ id: 'BulkReplayRequest' });
export const BulkReplayResponse = z
  .object({
    replayed: z.number().int(),
    failed: z
      .array(z.object({ service: z.string(), id: z.string().describe("'*' when the service's dead letters could not be listed"), error: z.string() }))
      .describe('Per-item failures; never silently dropped'),
  })
  .meta({ id: 'BulkReplayResult' });

export const DEAD_LETTER_SERVICES = ['identity', 'marketplace', 'orders', 'payments', 'delivery', 'notifications'] as const;
export const DeadLetterListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export const DeadLetterReplayParams = z.object({ service: z.string().min(1).max(32), id: z.string().min(1).max(200) });
export const AggregatedDeadLettersResponse = z
  .object({
    items: z.array(DeadLetterViewSchema.extend({ service: z.string() })),
    errors: z.array(z.object({ service: z.string(), code: z.string(), message: z.string() })).describe('Services that could not be queried; never silently dropped'),
    sources: z.array(z.string()),
  })
  .meta({ id: 'AggregatedDeadLetters' });
export const ReplayResponse = z.object({ id: z.string(), stream: z.string(), entryId: z.string() }).meta({ id: 'DeadLetterReplay' });

export const FailModeBody = z.object({ sms: z.boolean(), email: z.boolean() }).strict().meta({ id: 'DemoFailMode' });

export const TwilioStatusForm = z
  .object({ MessageSid: z.string(), MessageStatus: z.string() })
  .catchall(z.string())
  .meta({ id: 'TwilioStatusCallback' });
export const ResendWebhookBody = z
  .object({ type: z.string(), created_at: z.string().optional(), data: z.record(z.string(), z.unknown()).optional() })
  .meta({ id: 'ResendWebhookEvent' });

// ---------- routes ----------
openapi.route({
  method: 'get',
  path: '/api/v1/notifications',
  tags: ['notifications'],
  summary: 'My in-app notifications (newest first)',
  security: 'bearer',
  request: { query: InAppListQuery },
  responses: { 200: { description: 'Page', content: json(InAppListResponse) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/notifications/:id/read',
  tags: ['notifications'],
  summary: 'Mark one of my in-app notifications as read (idempotent)',
  security: 'bearer',
  request: { params: IdParams },
  errors: ['NOT_FOUND'],
  responses: { 200: { description: 'Updated', content: json(z.object({ id: ObjectIdSchema, readAt: z.string() })) } },
});

openapi.route({
  method: 'post',
  path: '/api/v1/realtime/ticket',
  tags: ['realtime'],
  summary: 'Exchange the access token for a 30 s single-use SSE ticket',
  security: 'bearer',
  rateLimited: true,
  responses: { 201: { description: 'Ticket', content: json(TicketResponse) } },
});
openapi.route({
  method: 'get',
  path: '/api/v1/realtime/stream',
  tags: ['realtime'],
  summary: 'Server-Sent Events stream (events: order.updated, owner.order, delivery.location, partner.offer, notification; `: ping` heartbeat)',
  description:
    'Open with EventSource after obtaining a ticket. Responds `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Single-use ticket.',
  request: { query: StreamQuery },
  errors: ['UNAUTHENTICATED'],
  responses: { 200: { description: 'Event stream', content: { 'text/event-stream': { schema: z.string() } } } },
});

openapi.route({
  method: 'post',
  path: '/api/v1/webhooks/twilio/status',
  tags: ['webhooks'],
  summary: 'Twilio message status callback (X-Twilio-Signature)',
  request: { body: { content: { 'application/x-www-form-urlencoded': { schema: TwilioStatusForm } } } },
  errors: ['WEBHOOK_SIGNATURE_INVALID', 'NOT_FOUND'],
  responses: { 204: { description: 'Accepted (idempotent)' } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/webhooks/resend',
  tags: ['webhooks'],
  summary: 'Resend webhook (Svix signature over the raw body; timestamp tolerance 5 min)',
  request: { body: { content: json(ResendWebhookBody) } },
  errors: ['WEBHOOK_SIGNATURE_INVALID', 'NOT_FOUND'],
  responses: { 200: { description: 'Accepted (idempotent)', content: json(z.object({ received: z.literal(true) })) } },
});

openapi.route({
  method: 'get',
  path: '/api/v1/admin/notifications',
  tags: ['admin'],
  summary: 'List notifications (ADMIN + MFA)',
  security: 'bearer',
  request: { query: AdminListQuery },
  responses: { 200: { description: 'Page', content: json(AdminListResponse) } },
});
openapi.route({
  method: 'get',
  path: '/api/v1/admin/notifications/summary',
  tags: ['admin'],
  summary: 'Counts by status, failures in the last 24 h per channel and the last provider error (ADMIN + MFA)',
  security: 'bearer',
  errors: ['MFA_REQUIRED'],
  responses: { 200: { description: 'Summary', content: json(NotificationSummaryResponse) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/notifications/retry',
  tags: ['admin'],
  summary: 'Bulk re-queue FAILED or DEAD notifications, oldest first, optionally by channel / created-before (ADMIN + MFA, audited; OTPs are never retried)',
  security: 'bearer',
  request: { body: { content: json(BulkRetryBody) } },
  errors: ['VALIDATION_FAILED', 'MFA_REQUIRED'],
  responses: { 200: { description: 'Number re-queued', content: json(BulkRetryResponse) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/notifications/:id/retry',
  tags: ['admin'],
  summary: 'Reset a DEAD/FAILED notification to QUEUED (ADMIN + MFA, audited)',
  security: 'bearer',
  request: { params: IdParams },
  errors: ['NOT_FOUND', 'CONFLICT', 'MFA_REQUIRED'],
  responses: { 200: { description: 'Re-queued', content: json(AdminNotificationView) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/notifications/dead-letters/replay',
  tags: ['admin'],
  summary: 'Replay un-replayed dead letters across services (or one `service`), oldest first, up to `limit` in total (ADMIN + MFA, audited)',
  security: 'bearer',
  request: { body: { content: json(BulkReplayBody) } },
  errors: ['VALIDATION_FAILED', 'MFA_REQUIRED'],
  responses: { 200: { description: 'Replayed count and per-item failures', content: json(BulkReplayResponse) } },
});
openapi.route({
  method: 'get',
  path: '/api/v1/admin/notifications/dead-letters',
  tags: ['admin'],
  summary: 'Event dead letters across all services (aggregated via internal calls; unreachable services listed in `errors`)',
  security: 'bearer',
  request: { query: DeadLetterListQuery },
  errors: ['MFA_REQUIRED'],
  responses: { 200: { description: 'Dead letters', content: json(AggregatedDeadLettersResponse) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/notifications/dead-letters/:service/:id/replay',
  tags: ['admin'],
  summary: 'Replay one dead-lettered event in its owning service (ADMIN + MFA, audited)',
  security: 'bearer',
  request: { params: DeadLetterReplayParams },
  errors: ['NOT_FOUND', 'CONFLICT', 'MFA_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT'],
  responses: { 200: { description: 'Replayed', content: json(ReplayResponse) } },
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/notifications/demo/fail-mode',
  tags: ['admin', 'demo'],
  summary: 'DEMO ONLY: make the mock SMS/email providers fail with 503 (404 outside APP_MODE=demo)',
  security: 'bearer',
  request: { body: { content: json(FailModeBody) } },
  errors: ['NOT_FOUND', 'MFA_REQUIRED'],
  responses: { 200: { description: 'Current state', content: json(z.object({ sms: z.boolean(), email: z.boolean() })) } },
});

openapi.route({
  method: 'post',
  path: '/internal/notifications/otp',
  tags: ['internal'],
  summary: 'Synchronously send an OTP SMS (caller: identity). The code is never persisted or logged.',
  security: 'internal',
  request: { body: { content: json(OtpBody) } },
  errors: ['OTP_DELIVERY_FAILED'],
  responses: { 202: { description: 'Sent', content: json(NotificationIdResponse) } },
});
openapi.route({
  method: 'post',
  path: '/internal/notifications/send',
  tags: ['internal'],
  summary: 'Queue a notification (idempotent by dedupeKey). Callers: identity, marketplace, orders, payments, delivery.',
  security: 'internal',
  request: { body: { content: json(SendBody) } },
  errors: ['NOT_FOUND'],
  responses: { 202: { description: 'Queued', content: json(NotificationIdResponse) } },
});
registerOpsRoutes(openapi);
