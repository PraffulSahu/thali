/**
 * Notification templates (SMS / email / in-app). Pure functions: `renderTemplate(name, data, channel)`.
 * Every interpolated value is HTML-escaped for email. Money is integer paise formatted without floats.
 * `secretKeys` are template-data keys that must never be stored in plain text or logged
 * (OTP code, email verification URL): the dispatcher encrypts them at rest.
 */
export type Channel = 'SMS' | 'EMAIL' | 'IN_APP';
export type TemplateData = Record<string, unknown>;

export interface Rendered {
  /** In-app title / email subject. */
  title: string;
  /** SMS body, in-app body, email plain-text part. */
  text: string;
  subject: string;
  html: string;
}

interface TemplateDef {
  channels: Channel[];
  secretKeys: string[];
  /** SMS is allowed regardless of `orderSms` preference (transactional). */
  transactionalSms?: boolean;
  /** Email is allowed regardless of `orderEmail` preference (account decisions the user must see). */
  transactionalEmail?: boolean;
  title(d: TemplateData): string;
  body(d: TemplateData): string;
  sms?(d: TemplateData): string;
}

// ---------- helpers ----------
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** `₹12,34,567.89` (Indian digit grouping), integer maths only. */
export function formatInr(paise: number): string {
  const p = Math.max(0, Math.trunc(paise));
  const rupees = String(Math.floor(p / 100));
  const frac = String(p % 100).padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}.${frac}`;
}
const money = (v: unknown): string => {
  const n = int(v);
  return n === null ? '' : formatInr(n);
};

export function formatIst(iso: unknown): string {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

const orderRef = (d: TemplateData) => (str(d.code) ? `order ${str(d.code)}` : 'your order');
const pretty = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 7)}${phone.slice(-4)}`;
}
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

const refundLine = (d: TemplateData): string => {
  const r = money(d.refundPaise);
  return int(d.refundPaise)! > 0 ? `A refund of ${r} is on its way to your original payment method.` : 'You will not be charged for this order.';
};

// ---------- definitions ----------
const ALL: Channel[] = ['IN_APP', 'SMS', 'EMAIL'];

export const TEMPLATES = {
  otp: {
    channels: ['SMS'],
    secretKeys: ['code'],
    title: () => 'Your Thali verification code',
    body: (d) => `${str(d.code)} is your Thali verification code. Do not share it with anyone.`,
  },
  order_placed_customer: {
    channels: ALL,
    secretKeys: [],
    transactionalSms: true,
    title: () => 'Order placed',
    body: (d) => `Your ${orderRef(d)}${money(d.totalPaise) ? ` (${money(d.totalPaise)})` : ''} has been placed. We will let you know as soon as the restaurant accepts it.`,
  },
  order_placed_restaurant: {
    channels: ALL,
    secretKeys: [],
    transactionalSms: true,
    title: () => 'New order received',
    body: (d) => `New ${orderRef(d)}${money(d.totalPaise) ? ` worth ${money(d.totalPaise)}` : ''}. Please accept or reject it${formatIst(d.acceptBy) ? ` before ${formatIst(d.acceptBy)}` : ' soon'}.`,
  },
  order_accepted: {
    channels: ALL,
    secretKeys: [],
    title: () => 'Order accepted',
    body: (d) => `The restaurant accepted ${orderRef(d)}${int(d.prepMinutes) ? ` and is preparing it (about ${int(d.prepMinutes)} min)` : ''}.`,
  },
  order_rejected: {
    channels: ALL,
    secretKeys: [],
    transactionalSms: true,
    title: () => 'Order rejected by the restaurant',
    body: (d) =>
      `Sorry, the restaurant could not take ${orderRef(d)}${str(d.reason) ? ` (${str(d.reason)})` : ''}. ${refundLine(d)} Any other restaurants in your checkout continue as planned.`,
    sms: (d) =>
      `Thali: the restaurant could not take ${orderRef(d)}. ${refundLine(d)} Your orders from other restaurants continue.`,
  },
  order_cancelled: {
    channels: ALL,
    secretKeys: [],
    title: () => 'Order cancelled',
    body: (d) => `${orderRef(d).replace(/^./, (c) => c.toUpperCase())} was cancelled${str(d.reason) ? `: ${str(d.reason)}` : ''}. ${refundLine(d)}`,
  },
  order_out_for_delivery: {
    channels: ALL,
    secretKeys: [],
    title: () => 'Your order is on the way',
    body: (d) => `${orderRef(d).replace(/^./, (c) => c.toUpperCase())} is out for delivery. Keep your delivery code handy.`,
  },
  order_delivered: {
    channels: ALL,
    secretKeys: [],
    title: () => 'Order delivered',
    body: (d) => `${orderRef(d).replace(/^./, (c) => c.toUpperCase())} has been delivered. Enjoy your meal!`,
  },
  refund_succeeded: {
    channels: ALL,
    secretKeys: [],
    title: () => 'Refund processed',
    body: (d) => `Your refund${money(d.amountPaise) ? ` of ${money(d.amountPaise)}` : ''} has been processed to your original payment method. It may take a few days to show up.`,
  },
  restaurant_email_verification: {
    channels: ['EMAIL'],
    secretKeys: ['verifyUrl'],
    title: () => 'Verify your restaurant email',
    body: (d) => `Please confirm this email address for your Thali restaurant account by opening the link below.\n\n${str(d.verifyUrl)}\n\nIf you did not request this, you can ignore this email.`,
  },
  /** IDN-1: identity sends it directly to the admin's address; the reset URL carries the token, so it is encrypted at rest. */
  ADMIN_PASSWORD_RESET: {
    channels: ['EMAIL'],
    secretKeys: ['resetUrl'],
    transactionalEmail: true,
    title: () => 'Reset your Thali admin password',
    body: (d) => {
      const mins = int(d.expiresMinutes);
      return `We received a request to reset the password of your Thali admin account. Open the link below to choose a new password. The link expires in ${mins && mins > 0 ? mins : 30} minutes.\n\n${str(d.resetUrl)}\n\nIf you did not request this, you can ignore this email and your password will stay as it is.`;
    },
  },
  restaurant_status_changed: {
    channels: ['IN_APP', 'EMAIL'],
    secretKeys: [],
    transactionalEmail: true,
    title: (d) => `${str(d.name, 'Your restaurant')} is now ${pretty(str(d.to, 'updated'))}`,
    body: (d) =>
      `Your restaurant${str(d.name) ? ` ${str(d.name)}` : ''} moved from ${pretty(str(d.from, 'its previous status'))} to ${pretty(str(d.to, 'a new status'))}.${str(d.reason) ? ` Reason: ${str(d.reason)}.` : ''}`,
  },
  partner_status_changed: {
    channels: ['IN_APP', 'EMAIL'],
    secretKeys: [],
    transactionalEmail: true,
    title: (d) => `Your delivery partner account is now ${pretty(str(d.to, 'updated'))}`,
    body: (d) => `Your delivery partner account moved from ${pretty(str(d.from, 'its previous status'))} to ${pretty(str(d.to, 'a new status'))}.${str(d.reason) ? ` Reason: ${str(d.reason)}.` : ''}`,
  },
  delivery_exception_admin: {
    channels: ['IN_APP'],
    secretKeys: [],
    title: () => 'Delivery exception',
    body: (d) => `Order ${str(d.childOrderId, 'unknown')} needs attention${str(d.jobId) ? ` (job ${str(d.jobId)})` : ''}: ${str(d.reason, 'no reason given')}.`,
  },
  membership_activated: {
    channels: ['IN_APP', 'EMAIL'],
    secretKeys: [],
    title: () => 'Thali membership activated',
    body: (d) => `Your membership is active${formatIst(d.endsAt) ? ` until ${formatIst(d.endsAt)}` : ''}. Enjoy your benefits!`,
  },
  restaurant_submitted_admin: {
    channels: ['IN_APP'],
    secretKeys: [],
    title: () => 'Restaurant submitted for approval',
    body: (d) => `Restaurant ${str(d.restaurantId, 'unknown')} was submitted and is waiting for review.`,
  },
} satisfies Record<string, TemplateDef>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];
export const isTemplateName = (v: unknown): v is TemplateName => typeof v === 'string' && Object.hasOwn(TEMPLATES, v);

export function templateDef(name: TemplateName): TemplateDef & { channels: Channel[] } {
  return TEMPLATES[name] as TemplateDef;
}

function toHtml(title: string, text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => {
      const escaped = escapeHtml(p).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
      return `<p style="margin:0 0 12px">${escaped.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222"><h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${paragraphs}<p style="margin:16px 0 0;color:#888;font-size:12px">Thali</p></div>`;
}

export function renderTemplate(name: TemplateName, data: TemplateData, channel: Channel): Rendered {
  const def = templateDef(name);
  const title = def.title(data);
  const body = def.body(data);
  const text = channel === 'SMS' ? (def.sms ? def.sms(data) : body) : body;
  return { title, subject: title, text, html: channel === 'EMAIL' ? toHtml(title, body) : '' };
}
