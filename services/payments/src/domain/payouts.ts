/**
 * Payouts are recorded after verified manual bank settlement (ADR-010): REQUESTED reduces available
 * balance; PAID only with a bank UTR, which also writes the PAYOUT ledger entry. No automated disbursement.
 */
import {
  DomainError,
  assertTransition,
  defineTransitions,
  formatINR,
  type ErrorCode,
  type PayoutStatus,
} from '@thali/contracts';
import { auditEvent, withTransaction } from '@thali/service-kit';
import { isValidObjectId } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import type { PayoutAttrs, PayoutDoc } from '../models/payout.js';
import { isDuplicateKey } from './intents.js';
import { accountSummary, postEntry } from './ledger.js';

/** Local payout state machine (not in @thali/contracts; see report "Contract gaps"). */
export const payoutTransitions = defineTransitions<PayoutStatus>('INVALID_TRANSITION', [
  { from: 'REQUESTED', to: 'PROCESSING', actors: ['ADMIN'] },
  { from: 'REQUESTED', to: 'PAID', actors: ['ADMIN'] },
  { from: 'PROCESSING', to: 'PAID', actors: ['ADMIN'] },
  { from: 'REQUESTED', to: 'FAILED', actors: ['ADMIN'] },
  { from: 'PROCESSING', to: 'FAILED', actors: ['ADMIN'] },
  { from: 'REQUESTED', to: 'CANCELLED', actors: ['ADMIN'] },
]);

/** Not in contracts ErrorCode yet (Contract gap): 422 business rule. */
export const PAYOUT_EXCEEDS_AVAILABLE = 'PAYOUT_EXCEEDS_AVAILABLE' as ErrorCode;

export interface Actor {
  userId: string;
  ip?: string;
  adminRoles: string[];
}

const actorRole = (a: Actor) => `ADMIN:${a.adminRoles.join('|') || 'ADMIN'}`;

export async function requestPayout(
  ctx: PaymentsContext,
  input: { accountType: 'RESTAURANT' | 'PARTNER'; accountId: string; amountPaise: number; notes?: string | null },
  actor: Actor,
): Promise<PayoutDoc> {
  const { Payout, AccountLock } = ctx.models;
  const lockId = `${input.accountType}:${input.accountId}`;
  await AccountLock.updateOne({ _id: lockId }, { $setOnInsert: { seq: 0 } }, { upsert: true }).catch((err: unknown) => {
    if (!isDuplicateKey(err)) throw err;
  });
  return withTransaction(ctx.conn, async (session) => {
    // Serialize payout requests per account: concurrent transactions write-conflict here and retry.
    await AccountLock.updateOne({ _id: lockId }, { $inc: { seq: 1 } }, { session });
    const summary = await accountSummary(ctx, input.accountType, input.accountId, session);
    if (input.amountPaise > summary.availablePaise) {
      throw new DomainError(PAYOUT_EXCEEDS_AVAILABLE, 'Payout exceeds the available balance', 422, {
        availablePaise: summary.availablePaise,
        requestedPaise: input.amountPaise,
      });
    }
    const now = ctx.now();
    const [payout] = await Payout.create(
      [
        {
          accountType: input.accountType,
          accountId: input.accountId,
          amountPaise: input.amountPaise,
          status: 'REQUESTED',
          method: 'MANUAL_BANK_TRANSFER',
          requestedBy: actor.userId,
          notes: input.notes ?? null,
          statusHistory: [{ from: null, to: 'REQUESTED', at: now, source: `admin:${actor.userId}` }],
        },
      ],
      { session },
    );
    await auditEvent(ctx.conn, session, {
      service: 'payments',
      actorId: actor.userId,
      actorRole: actorRole(actor),
      action: 'payout.request',
      targetType: 'payout',
      targetId: payout!.id as string,
      summary: `Payout ${formatINR(input.amountPaise)} requested for ${input.accountType} ${input.accountId}`,
      ...(actor.ip ? { ip: actor.ip } : {}),
    });
    return payout!;
  });
}

async function loadForTransition(ctx: PaymentsContext, id: string, session: import('mongoose').ClientSession) {
  if (!isValidObjectId(id)) throw new DomainError('NOT_FOUND', 'Payout not found');
  const p = await ctx.models.Payout.findById(id).session(session);
  if (!p) throw new DomainError('NOT_FOUND', 'Payout not found');
  return p;
}

export async function confirmPayout(ctx: PaymentsContext, id: string, utr: string, actor: Actor): Promise<PayoutDoc> {
  try {
    return await withTransaction(ctx.conn, async (session) => {
      const p = await loadForTransition(ctx, id, session);
      assertTransition(payoutTransitions, p.status, 'PAID', 'ADMIN');
      const now = ctx.now();
      const updated = await ctx.models.Payout.findOneAndUpdate(
        { _id: p._id, status: p.status },
        {
          $set: { status: 'PAID', utr, confirmedBy: actor.userId, confirmedAt: now },
          $inc: { version: 1 },
          $push: { statusHistory: { from: p.status, to: 'PAID', at: now, source: `admin:${actor.userId}` } },
        },
        { session, new: true },
      );
      if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Payout changed concurrently');
      await postEntry(ctx, session, {
        accountType: p.accountType,
        accountId: p.accountId,
        entryType: 'PAYOUT',
        amountPaise: -p.amountPaise,
        dedupeKey: `payout:${p.id as string}`,
        memo: `Manual bank transfer UTR ${utr}`,
        createdBy: actor.userId,
        payoutId: p.id as string,
      });
      await auditEvent(ctx.conn, session, {
        service: 'payments',
        actorId: actor.userId,
        actorRole: actorRole(actor),
        action: 'payout.confirm',
        targetType: 'payout',
        targetId: p.id as string,
        summary: `Payout ${formatINR(p.amountPaise)} to ${p.accountType} ${p.accountId} confirmed with UTR ${utr}`,
        ...(actor.ip ? { ip: actor.ip } : {}),
      });
      return updated;
    });
  } catch (err) {
    if (isDuplicateKey(err, 'payouts')) throw new DomainError('CONFLICT', 'This UTR is already recorded against another payout', 409);
    throw err;
  }
}

export async function failPayout(ctx: PaymentsContext, id: string, reason: string, actor: Actor): Promise<PayoutDoc> {
  return withTransaction(ctx.conn, async (session) => {
    const p = await loadForTransition(ctx, id, session);
    assertTransition(payoutTransitions, p.status, 'FAILED', 'ADMIN');
    const now = ctx.now();
    const updated = await ctx.models.Payout.findOneAndUpdate(
      { _id: p._id, status: p.status },
      {
        $set: { status: 'FAILED', failureReason: reason },
        $inc: { version: 1 },
        $push: { statusHistory: { from: p.status, to: 'FAILED', at: now, source: `admin:${actor.userId}` } },
      },
      { session, new: true },
    );
    if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Payout changed concurrently');
    await auditEvent(ctx.conn, session, {
      service: 'payments',
      actorId: actor.userId,
      actorRole: actorRole(actor),
      action: 'payout.fail',
      targetType: 'payout',
      targetId: p.id as string,
      summary: `Payout ${formatINR(p.amountPaise)} to ${p.accountType} ${p.accountId} marked failed: ${reason}`,
      ...(actor.ip ? { ip: actor.ip } : {}),
    });
    return updated;
  });
}

export function payoutView(p: PayoutAttrs) {
  return {
    id: String(p._id),
    accountType: p.accountType,
    accountId: p.accountId,
    amountPaise: p.amountPaise,
    status: p.status,
    method: p.method,
    utr: p.utr ?? null,
    requestedBy: p.requestedBy,
    confirmedBy: p.confirmedBy ?? null,
    confirmedAt: p.confirmedAt ? new Date(p.confirmedAt).toISOString() : null,
    failureReason: p.failureReason ?? null,
    notes: p.notes ?? null,
    createdAt: new Date(p.createdAt).toISOString(),
    updatedAt: new Date(p.updatedAt).toISOString(),
  };
}
