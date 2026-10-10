/** `users` (LLD §3.1). */
import { Schema, type Connection, type Types } from 'mongoose';
import { AdminRole, Role, enumValues, type AdminRole as AdminRoleT, type Role as RoleT } from '@thali/contracts';
import { defineModel } from './_model.js';

export const USER_STATUS = ['ACTIVE', 'BLOCKED'] as const;
export type UserStatus = (typeof USER_STATUS)[number];
export const MAX_ADDRESSES = 10;

export interface AddressDoc {
  _id: Types.ObjectId;
  label?: string;
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  pincode: string;
  location: { type: 'Point'; coordinates: [number, number] };
  isDefault: boolean;
}

export interface NotificationPrefs {
  orderSms: boolean;
  orderEmail: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
}

export interface UserDoc {
  _id: Types.ObjectId;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  roles: RoleT[];
  adminRoles: AdminRoleT[];
  status: UserStatus;
  addresses: Types.DocumentArray<AddressDoc & Types.Subdocument>;
  notificationPrefs: NotificationPrefs;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<AddressDoc>(
  {
    label: { type: String },
    line1: { type: String, required: true },
    line2: { type: String },
    landmark: { type: String },
    city: { type: String, required: true },
    pincode: { type: String, required: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point', required: true },
      coordinates: { type: [Number], required: true },
    },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true },
);

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  orderSms: true,
  orderEmail: true,
  marketingSms: false,
  marketingEmail: false,
};

const UserSchema = new Schema<UserDoc>(
  {
    phone: { type: String },
    email: { type: String, lowercase: true, trim: true },
    name: { type: String, trim: true },
    roles: { type: [{ type: String, enum: enumValues(Role) }], default: ['CONSUMER'] },
    adminRoles: { type: [{ type: String, enum: enumValues(AdminRole) }], default: [] },
    status: { type: String, enum: USER_STATUS, default: 'ACTIVE', required: true },
    addresses: { type: [AddressSchema], default: [] },
    notificationPrefs: {
      orderSms: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.orderSms },
      orderEmail: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.orderEmail },
      marketingSms: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.marketingSms },
      marketingEmail: { type: Boolean, default: DEFAULT_NOTIFICATION_PREFS.marketingEmail },
    },
    deletedAt: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true },
);
// "unique sparse" (LLD) implemented as partial indexes so anonymized users (phone/email null) never collide.
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
UserSchema.index({ roles: 1 });
UserSchema.index({ createdAt: -1, _id: -1 });

export const UserModel = (conn: Connection) => defineModel<UserDoc>(conn, 'User', UserSchema);
