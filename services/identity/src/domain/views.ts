import { Types } from 'mongoose';
import type { AddressDoc, UserDoc } from '../models/user.js';
import type { AuditLogDoc } from '../models/audit-log.js';

/** Resolves a stored image ref (upload key or allowlisted https URL) to a browser URL, or null. */
export type ImageResolver = (ref: string | null | undefined) => string | null;

export function toAddressView(a: AddressDoc) {
  return {
    id: String(a._id),
    label: a.label ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
    landmark: a.landmark ?? null,
    locality: a.locality ?? null,
    formattedAddress: a.formattedAddress ?? null,
    city: a.city,
    pincode: a.pincode,
    location: { lat: a.location.coordinates[1], lng: a.location.coordinates[0] },
    isDefault: !!a.isDefault,
  };
}

function prefsOf(u: Pick<UserDoc, 'notificationPrefs'>) {
  const p = u.notificationPrefs ?? ({} as UserDoc['notificationPrefs']);
  return {
    orderSms: p.orderSms ?? true,
    orderEmail: p.orderEmail ?? true,
    marketingSms: p.marketingSms ?? false,
    marketingEmail: p.marketingEmail ?? false,
  };
}

export function toUserView(u: UserDoc, imageUrl: ImageResolver) {
  return {
    id: String(u._id),
    phone: u.phone ?? null,
    email: u.email ?? null,
    name: u.name ?? null,
    avatarUrl: imageUrl(u.avatarKey),
    roles: [...u.roles],
    adminRoles: [...(u.adminRoles ?? [])],
    status: u.status,
    notificationPrefs: prefsOf(u),
    addresses: (u.addresses ?? []).map((a) => toAddressView(a)),
    createdAt: new Date(u.createdAt).toISOString(),
  };
}

/** Binding shape for `GET /internal/users/:id`. */
export function toInternalUserView(u: UserDoc, imageUrl: ImageResolver) {
  return {
    id: String(u._id),
    phone: u.phone ?? null,
    email: u.email ?? null,
    name: u.name ?? null,
    avatarUrl: imageUrl(u.avatarKey),
    roles: [...u.roles],
    status: u.status,
    notificationPrefs: prefsOf(u),
  };
}

export function toAuditLogView(l: AuditLogDoc) {
  return {
    id: String(l._id),
    eventId: l.eventId,
    actorId: l.actorId,
    actorRole: l.actorRole,
    action: l.action,
    targetType: l.targetType,
    targetId: l.targetId,
    summary: l.summary,
    ip: l.ip ?? null,
    correlationId: l.correlationId,
    service: l.service,
    occurredAt: new Date(l.occurredAt).toISOString(),
  };
}

/** Parse an ObjectId hex string; `null` when malformed (callers answer 404). */
export function oid(id: string): Types.ObjectId | null {
  return /^[0-9a-fA-F]{24}$/.test(id) ? new Types.ObjectId(id) : null;
}
