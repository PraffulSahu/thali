/**
 * Delivery engine: creates notification records (idempotent by `dedupeKey`), claims and sends them
 * through the providers, and applies the retry policy (exponential backoff, DEAD after N attempts or on a
 * permanent provider error). A notification is claimed with one atomic QUEUED|FAILED -> SENDING update, so
 * concurrent instances / pollers never send the same attempt twice.
 */
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { Logger } from 'pino';
import { DomainError } from '@thali/contracts';
import { decryptField, encryptField } from '@thali/service-kit';
import type { NotificationDoc, NotificationModel } from '../models/notification.js';
import type { ProviderCallbackModel } from '../models/provider-callback.js';
import type { EmailProvider } from '../providers/email.js';
import type { SmsProvider } from '../providers/sms.js';
import type { RealtimePublisher } from '../realtime/publish.js';
import { skipReason, type OrdersLookup, type RecipientDirectory } from './recipients.js';
import { describeError, isRetryable, nextDelaySec } from './retry.js';
import { isTemplateName, maskEmail, maskPhone, renderTemplate, templateDef, type Channel, type TemplateData, type TemplateName } from './templates.js';

export interface EnqueueInput {
  channel: Channel;
  template: string;
  data: TemplateData;
  dedupeKey: string;
  userId?: string;
  /** Raw phone (E.164) / email address for SMS and EMAIL. Omit to resolve from `userId` at dispatch time. */
  to?: string;
  /** Resolve the user from this child order at dispatch time (refund events carry no user id). */
  recipientChildOrderId?: string;
  audience?: 'ADMIN';
  sourceEventId?: string;
}

export interface DispatcherDeps {
  models: { Notification: NotificationModel; ProviderCallback: ProviderCallbackModel };
  sms: SmsProvider;
  email: EmailProvider;
  realtime: RealtimePublisher;
  /** Recipient phone/email + preferences, looked up at dispatch time (never inside a transaction). */
  directory: RecipientDirectory;
  orders: OrdersLookup;
  /** base64 32-byte key (`FIELD_ENCRYPTION_KEY`). */
  encryptionKey: string;
  maxAttempts: number;
  retryBaseSec: number;
  retryMaxSec: number;
  sendingTimeoutSec: number;
  statusCallbackUrl?: string;
  logger: Logger;
  now?: () => Date;
  /** `kick()` schedules an immediate best-effort dispatch. Default true. */
  autoKick?: boolean;
  onProviderError?: (provider: string) => void;
}

export type CallbackOutcome = 'applied' | 'ignored' | 'not_found';
export type ProviderStatus = 'SENT' | 'DELIVERED' | 'DEAD';

const BEFORE_SENT = ['QUEUED', 'SENDING', 'FAILED'] as const;

export class Dispatcher {
  private readonly now: () => Date;

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ---------- creation ----------

  /** Insert (or find) the notification for `dedupeKey`. Safe inside a transaction (`opts.session`). */
  async enqueue(input: EnqueueInput, opts: { session?: ClientSession } = {}): Promise<{ id: string; created: boolean }> {
    const { Notification } = this.d.models;
    if (!isTemplateName(input.template)) throw new DomainError('VALIDATION_FAILED', `Unknown template '${input.template}'`);
    const def = templateDef(input.template);
    if (!def.channels.includes(input.channel)) {
      throw new DomainError('VALIDATION_FAILED', `Template '${input.template}' does not support channel ${input.channel}`);
    }
    const hasUser = Boolean(input.userId || input.recipientChildOrderId);
    if (input.channel !== 'IN_APP' && !input.to && !hasUser) {
      throw new DomainError('VALIDATION_FAILED', `${input.channel} notifications need a recipient address or user`);
    }
    if (input.channel === 'IN_APP' && !hasUser && input.audience !== 'ADMIN') {
      throw new DomainError('VALIDATION_FAILED', 'IN_APP notifications need a userId');
    }

    const secret: TemplateData = {};
    const data: TemplateData = {};
    for (const [k, v] of Object.entries(input.data ?? {})) (def.secretKeys.includes(k) ? secret : data)[k] = v;
    const rendered = input.channel === 'IN_APP' ? renderTemplate(input.template, { ...data, ...secret }, 'IN_APP') : null;
    const now = this.now();

    const doc: Partial<NotificationDoc> = {
      userId: input.userId ?? null,
      recipientChildOrderId: input.recipientChildOrderId ?? null,
      audience: input.audience ?? null,
      channel: input.channel,
      to: !input.to ? '' : input.channel === 'SMS' ? maskPhone(input.to) : maskEmail(input.to),
      toEnc: input.to && input.channel !== 'IN_APP' ? encryptField(input.to, this.d.encryptionKey) : null,
      template: input.template,
      data,
      secretEnc: Object.keys(secret).length ? encryptField(JSON.stringify(secret), this.d.encryptionKey) : null,
      title: rendered?.title ?? null,
      body: rendered?.text ?? null,
      status: 'QUEUED',
      attempts: 0,
      nextAttemptAt: now,
      sourceEventId: input.sourceEventId ?? null,
      readAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const res = await Notification.updateOne({ dedupeKey: input.dedupeKey }, { $setOnInsert: doc }, { upsert: true, ...(opts.session ? { session: opts.session } : {}) });
    if (res.upsertedId) return { id: String(res.upsertedId), created: true };
    const existing = await Notification.findOne({ dedupeKey: input.dedupeKey }, { _id: 1 }).session(opts.session ?? null).lean();
    return { id: String(existing!._id), created: false };
  }

  /** Fire-and-forget dispatch shortly after commit; the poller is the safety net. */
  kick(ids: string[]): void {
    if (this.d.autoKick === false || ids.length === 0) return;
    const t = setTimeout(() => {
      for (const id of ids) void this.dispatchById(id).catch((err) => this.d.logger.warn({ err, notificationId: id }, 'kick dispatch failed'));
    }, 50);
    t.unref();
  }

  // ---------- dispatch ----------

  /** Claim + send one notification if it is due. */
  async dispatchById(id: string): Promise<void> {
    const now = this.now();
    const claimed = await this.d.models.Notification.findOneAndUpdate(
      { _id: id, status: { $in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { $lte: now } },
      { $set: { status: 'SENDING', sendingAt: now, updatedAt: now }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (claimed) await this.deliver(claimed);
  }

  /** Poll: recover stuck SENDING rows, then dispatch everything due. Returns how many were attempted. */
  async dispatchDue(limit = 50): Promise<number> {
    const { Notification } = this.d.models;
    const now = this.now();
    const stuck = { status: 'SENDING', sendingAt: { $lte: new Date(now.getTime() - this.d.sendingTimeoutSec * 1000) } };
    // OTP codes are never stored, so an interrupted OTP send can only be failed, never resent.
    await Notification.updateMany({ ...stuck, template: 'otp' }, { $set: { status: 'FAILED', nextAttemptAt: null, lastError: 'send interrupted', updatedAt: now } });
    await Notification.updateMany(
      { ...stuck, attempts: { $gte: this.d.maxAttempts } },
      { $set: { status: 'DEAD', nextAttemptAt: null, lastError: 'send interrupted; attempts exhausted', updatedAt: now } },
    );
    await Notification.updateMany(stuck, { $set: { status: 'FAILED', nextAttemptAt: now, lastError: 'send interrupted; will retry', updatedAt: now } });

    const due = await Notification.find({ status: { $in: ['QUEUED', 'FAILED'] }, nextAttemptAt: { $lte: now } }, { _id: 1 })
      .sort({ nextAttemptAt: 1 })
      .limit(limit)
      .lean();
    for (let i = 0; i < due.length; i += 5) {
      await Promise.all(
        due.slice(i, i + 5).map((n) => this.dispatchById(String(n._id)).catch((err) => this.d.logger.error({ err, notificationId: String(n._id) }, 'dispatch crashed'))),
      );
    }
    return due.length;
  }

  private async deliver(n: NotificationDoc): Promise<void> {
    const id = String(n._id);
    const provider = n.channel === 'SMS' ? this.d.sms : this.d.email;

    // 1. Recipient resolution (identity / orders): outside any transaction; an outage is an ordinary retryable failure.
    let to: string | undefined;
    try {
      const resolved = await this.resolveRecipient(n);
      if ('skip' in resolved) return void (await this.recordSkipped(n, resolved.skip));
      n = resolved.notification;
      to = resolved.to;
    } catch (err) {
      return void (await this.recordFailure(n, n.channel === 'IN_APP' ? 'in_app' : provider.name, err, false));
    }

    if (n.channel === 'IN_APP') {
      await this.persistSent(id, { provider: 'in_app', providerMessageId: null });
      const push = { id, title: n.title ?? '', body: n.body ?? '' };
      if (n.audience === 'ADMIN') await this.d.realtime.toAdmin('notification', push);
      else if (n.userId) await this.d.realtime.toUser(n.userId, 'notification', push);
      return;
    }

    // 2. The provider call is the only thing whose failure means "not sent".
    let providerMessageId: string;
    try {
      const secret = n.secretEnc ? (JSON.parse(decryptField(n.secretEnc, this.d.encryptionKey)) as TemplateData) : {};
      const rendered = renderTemplate(n.template as TemplateName, { ...n.data, ...secret }, n.channel);
      const result =
        n.channel === 'SMS'
          ? await this.d.sms.send({ to: to!, body: rendered.text, notificationId: id, statusCallbackUrl: this.d.statusCallbackUrl })
          : await this.d.email.send({ to: to!, subject: rendered.subject, html: rendered.html, text: rendered.text, idempotencyKey: n.dedupeKey, notificationId: id });
      providerMessageId = result.providerMessageId;
    } catch (err) {
      return void (await this.recordFailure(n, provider.name, err));
    }

    // 3. The provider accepted the message: a bookkeeping failure must never turn into a retry (duplicate send).
    await this.persistSent(id, { provider: provider.name, providerMessageId });
  }

  /** Decrypt a stored recipient, or look the user up (identity) and apply preferences. */
  private async resolveRecipient(n: NotificationDoc): Promise<{ skip: string } | { to?: string; notification: NotificationDoc }> {
    const { Notification } = this.d.models;
    let userId = n.userId ?? undefined;
    if (!userId && n.recipientChildOrderId) {
      const order = await this.d.orders.getChildOrder(n.recipientChildOrderId);
      if (!order) return { skip: 'RECIPIENT_NOT_FOUND' };
      userId = order.userId;
      await Notification.updateOne({ _id: n._id }, { $set: { userId } });
      n = { ...n, userId };
    }
    if (n.channel === 'IN_APP') return { notification: n };
    if (n.toEnc) return { to: decryptField(n.toEnc, this.d.encryptionKey), notification: n };
    if (!userId) return { skip: 'RECIPIENT_NOT_FOUND' };

    const user = await this.d.directory.getUser(userId);
    if (!user) return { skip: 'RECIPIENT_NOT_FOUND' };
    const reason = skipReason(n.template as TemplateName, n.channel, user);
    if (reason) return { skip: reason };
    const to = (n.channel === 'SMS' ? user.phone : user.email)!;
    await Notification.updateOne(
      { _id: n._id },
      { $set: { to: n.channel === 'SMS' ? maskPhone(to) : maskEmail(to), toEnc: encryptField(to, this.d.encryptionKey) } },
    );
    return { to, notification: n };
  }

  /** Bounded retry of the post-send write. If it still fails the row stays SENDING (never re-sent from here). */
  private async persistSent(id: string, info: { provider: string; providerMessageId: string | null }): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.recordSent(id, info);
        return true;
      } catch (err) {
        this.d.logger.error({ err, notificationId: id, provider: info.provider, attempt }, 'message accepted by provider but recording the status failed');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
    return false;
  }

  /** SENDING|QUEUED|FAILED -> SENT, then apply any provider callback that raced ahead of this write. */
  async recordSent(id: string, info: { provider: string; providerMessageId: string | null }): Promise<void> {
    const now = this.now();
    const updated = await this.d.models.Notification.findOneAndUpdate(
      { _id: id, status: { $in: BEFORE_SENT } },
      { $set: { status: 'SENT', provider: info.provider, providerMessageId: info.providerMessageId, sentAt: now, nextAttemptAt: null, lastError: null, updatedAt: now } },
      { new: true },
    ).lean();
    if (updated && info.providerMessageId) await this.applyPendingCallbacks(info.provider, info.providerMessageId);
  }

  private async recordSkipped(n: NotificationDoc, reason: string): Promise<void> {
    const now = this.now();
    this.d.logger.info({ notificationId: String(n._id), channel: n.channel, template: n.template, reason }, 'notification skipped');
    await this.d.models.Notification.updateOne(
      { _id: n._id, status: 'SENDING' },
      { $set: { status: 'SKIPPED', skipReason: reason, nextAttemptAt: null, updatedAt: now } },
    );
  }

  private async recordFailure(n: NotificationDoc, provider: string, err: unknown, countProviderError = true): Promise<void> {
    const now = this.now();
    const retryable = isRetryable(err);
    const dead = !retryable || n.attempts >= this.d.maxAttempts;
    if (countProviderError) this.d.onProviderError?.(provider);
    this.d.logger.warn(
      { notificationId: String(n._id), channel: n.channel, provider, attempt: n.attempts, retryable, final: dead, status: (err as { status?: number }).status, code: (err as { code?: string }).code, ...(countProviderError ? {} : { stage: 'recipient-lookup' }) },
      'notification delivery failed',
    );
    await this.d.models.Notification.updateOne(
      { _id: n._id, status: 'SENDING' },
      {
        $set: {
          status: dead ? 'DEAD' : 'FAILED',
          provider,
          lastError: describeError(err),
          nextAttemptAt: dead ? null : new Date(now.getTime() + nextDelaySec(n.attempts, this.d.retryBaseSec, this.d.retryMaxSec) * 1000),
          updatedAt: now,
        },
      },
    );
  }

  // ---------- OTP (synchronous, body never persisted) ----------

  /** Sends an OTP immediately. The record never contains the code; failure -> FAILED (no retry) + 503. */
  async sendOtp(phone: string, code: string): Promise<{ id: string }> {
    const now = this.now();
    const created = await this.d.models.Notification.create({
      channel: 'SMS',
      to: maskPhone(phone),
      toEnc: encryptField(phone, this.d.encryptionKey),
      template: 'otp',
      data: {},
      status: 'SENDING',
      attempts: 1,
      nextAttemptAt: null,
      sendingAt: now,
      provider: this.d.sms.name,
      dedupeKey: `otp:${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    });
    const id = String(created._id);
    let providerMessageId: string;
    try {
      const result = await this.d.sms.send({ to: phone, body: renderTemplate('otp', { code }, 'SMS').text, notificationId: id, statusCallbackUrl: this.d.statusCallbackUrl });
      providerMessageId = result.providerMessageId;
    } catch (err) {
      this.d.onProviderError?.(this.d.sms.name);
      this.d.logger.warn({ notificationId: id, provider: this.d.sms.name, status: (err as { status?: number }).status, code: (err as { code?: string }).code }, 'otp delivery failed');
      await this.d.models.Notification.updateOne(
        { _id: id, status: 'SENDING' },
        { $set: { status: 'FAILED', nextAttemptAt: null, lastError: describeError(err), updatedAt: this.now() } },
      ).catch((e) => this.d.logger.error({ err: e, notificationId: id }, 'could not record otp failure'));
      throw new DomainError('OTP_DELIVERY_FAILED', 'We could not send the verification code. Please try again shortly.');
    }
    // The SMS is out: whatever happens to the bookkeeping, the caller must see success (never 503 after sending).
    await this.persistSent(id, { provider: this.d.sms.name, providerMessageId });
    return { id };
  }

  // ---------- provider status callbacks ----------

  /** Apply a verified provider status (monotonic: never downgrades DELIVERED / DEAD). */
  async applyProviderStatus(input: { provider: string; providerMessageId: string; status: ProviderStatus; error?: string | null }): Promise<CallbackOutcome> {
    const { Notification } = this.d.models;
    const now = this.now();
    const filter = { provider: input.provider, providerMessageId: input.providerMessageId };
    const from: string[] = input.status === 'SENT' ? [...BEFORE_SENT] : [...BEFORE_SENT, 'SENT'];
    const set: Record<string, unknown> = { status: input.status, updatedAt: now };
    if (input.status === 'DELIVERED') Object.assign(set, { deliveredAt: now, nextAttemptAt: null, lastError: null });
    if (input.status === 'DEAD') Object.assign(set, { nextAttemptAt: null, lastError: (input.error ?? 'provider reported a delivery failure').slice(0, 300) });
    if (input.status === 'SENT') Object.assign(set, { sentAt: now });
    const res = await Notification.updateOne({ ...filter, status: { $in: from } }, { $set: set });
    if (res.modifiedCount > 0) return 'applied';
    return (await Notification.exists(filter)) ? 'ignored' : 'not_found';
  }

  private async applyPendingCallbacks(provider: string, providerMessageId: string): Promise<void> {
    const { ProviderCallback } = this.d.models;
    const pending = await ProviderCallback.find({ provider, providerMessageId, applied: false }).sort({ receivedAt: 1 }).lean();
    for (const cb of pending) {
      if (cb.mappedStatus) await this.applyProviderStatus({ provider, providerMessageId, status: cb.mappedStatus, error: cb.error });
      await ProviderCallback.updateOne({ _id: cb._id }, { $set: { applied: true } });
    }
  }
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return new Dispatcher(deps);
}
