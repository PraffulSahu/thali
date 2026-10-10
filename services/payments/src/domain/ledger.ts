/**
 * Financial ledger (append-only, signed paise, unique dedupeKey) and balances (LLD §3.4).
 *   Balance   = Σ entries for the account.
 *   Available = Σ positive non-PAYOUT entries older than PAYOUT_HOLD_DAYS (only earnings are held)
 *               + Σ negative entries (commission, adjustments, payouts — applied immediately)
 *               − amounts of REQUESTED/PROCESSING payouts,
 *               capped to [0, balance − pending] so it can never exceed what is actually owed.
 * ORDER_EARNING = itemsSubtotal + packaging (controller ruling: discounts are platform-funded).
 */
import { DomainError, bpsOf, type EventPayloads, type LedgerAccountType, type LedgerEntryType } from '@thali/contracts';
import type { ClientSession } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import { PLATFORM_ACCOUNT_ID, type LedgerEntryAttrs } from '../models/ledger-entry.js';

export interface PostEntryInput {
  accountType: LedgerAccountType;
  accountId: string;
  entryType: LedgerEntryType;
  amountPaise: number;
  dedupeKey: string;
  memo: string;
  createdBy: string;
  childOrderId?: string | null;
  deliveryJobId?: string | null;
  payoutId?: string | null;
  refundId?: string | null;
}

/** Insert-if-absent by dedupeKey (no error on replays, safe inside transactions). Returns true when inserted. */
export async function postEntry(ctx: PaymentsContext, session: ClientSession, e: PostEntryInput): Promise<boolean> {
  if (!Number.isInteger(e.amountPaise)) throw new Error(`ledger amount must be integer paise (${e.dedupeKey})`);
  const now = ctx.now();
  const res = await ctx.models.LedgerEntry.updateOne(
    { dedupeKey: e.dedupeKey },
    {
      $setOnInsert: {
        accountType: e.accountType,
        accountId: e.accountId,
        entryType: e.entryType,
        amountPaise: e.amountPaise,
        dedupeKey: e.dedupeKey,
        memo: e.memo,
        createdBy: e.createdBy,
        childOrderId: e.childOrderId ?? null,
        deliveryJobId: e.deliveryJobId ?? null,
        payoutId: e.payoutId ?? null,
        refundId: e.refundId ?? null,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, session, timestamps: false },
  );
  return res.upsertedCount === 1;
}

/** Partner payout: base + ceil(distanceKm) × perKm, distance normalised to 0.01 km to remove float noise. */
export function deliveryEarningPaise(distanceKm: number, basePaise: number, perKmPaise: number): number {
  const hundredths = Math.max(0, Math.round(distanceKm * 100));
  const km = Math.floor((hundredths + 99) / 100);
  return basePaise + km * perKmPaise;
}

/** Ledger postings for a delivered child order (idempotent via dedupe keys). */
export async function recordDeliveryEarnings(
  ctx: PaymentsContext,
  session: ClientSession,
  p: EventPayloads['order.delivered'],
  createdBy = 'system:order.delivered',
): Promise<void> {
  const b = p.breakdown;
  // Controller ruling (Task 10 review): discounts (coupon/membership) are platform-funded, so the
  // restaurant earns the full item subtotal plus packaging.
  const earning = b.itemsSubtotalPaise + b.packagingFeePaise;
  const commission = bpsOf(b.itemsSubtotalPaise, p.commissionBps);
  await postEntry(ctx, session, {
    accountType: 'RESTAURANT',
    accountId: p.restaurantId,
    entryType: 'ORDER_EARNING',
    amountPaise: earning,
    dedupeKey: `earning:${p.childOrderId}`,
    memo: `Order earning (items ${b.itemsSubtotalPaise} + packaging ${b.packagingFeePaise}; discounts platform-funded)`,
    createdBy,
    childOrderId: p.childOrderId,
  });
  await postEntry(ctx, session, {
    accountType: 'RESTAURANT',
    accountId: p.restaurantId,
    entryType: 'COMMISSION',
    amountPaise: -commission,
    dedupeKey: `commission:${p.childOrderId}`,
    memo: `Platform commission ${p.commissionBps} bps of ${b.itemsSubtotalPaise}`,
    createdBy,
    childOrderId: p.childOrderId,
  });
  await postEntry(ctx, session, {
    accountType: 'PLATFORM',
    accountId: PLATFORM_ACCOUNT_ID,
    entryType: 'COMMISSION',
    amountPaise: commission,
    dedupeKey: `platform-commission:${p.childOrderId}`,
    memo: `Commission from restaurant ${p.restaurantId}`,
    createdBy,
    childOrderId: p.childOrderId,
  });
  if (p.deliveryJobId && p.partnerUserId) {
    const distanceOk = typeof p.deliveryDistanceKm === 'number' && Number.isFinite(p.deliveryDistanceKm) && p.deliveryDistanceKm >= 0;
    if (!distanceOk) {
      ctx.logger.error(
        { alert: 'LEDGER_DISTANCE_MISSING', childOrderId: p.childOrderId, deliveryJobId: p.deliveryJobId, deliveryDistanceKm: p.deliveryDistanceKm },
        'order.delivered without a valid deliveryDistanceKm; partner credited the base rate only',
      );
    }
    const distanceKm = distanceOk ? p.deliveryDistanceKm : 0;
    await postEntry(ctx, session, {
      accountType: 'PARTNER',
      accountId: p.partnerUserId,
      entryType: 'DELIVERY_EARNING',
      amountPaise: deliveryEarningPaise(distanceKm, ctx.config.PARTNER_BASE_PAYOUT_PAISE, ctx.config.PARTNER_PER_KM_PAISE),
      dedupeKey: `delivery:${p.deliveryJobId}`,
      memo: distanceOk ? `Delivery earning (${distanceKm} km)` : 'Delivery earning (distance missing: base rate only)',
      createdBy,
      childOrderId: p.childOrderId,
      deliveryJobId: p.deliveryJobId,
    });
  } else {
    ctx.logger.error({ alert: 'LEDGER_PARTNER_MISSING', childOrderId: p.childOrderId }, 'order.delivered without partner/job; no delivery earning posted');
  }
}

export interface AccountSummary {
  accountType: LedgerAccountType;
  accountId: string;
  balancePaise: number;
  availablePaise: number;
  pendingPayoutPaise: number;
  paidOutPaise: number;
  holdDays: number;
  totalsByType: Partial<Record<LedgerEntryType, number>>;
  asOf: string;
}

interface Rollup {
  balance: number;
  maturedNonPayout: number;
  payoutTotal: number;
  totalsByType: Partial<Record<LedgerEntryType, number>>;
}

function holdCutoff(ctx: PaymentsContext): Date {
  return new Date(ctx.now().getTime() - ctx.config.PAYOUT_HOLD_DAYS * 86_400_000);
}

async function rollup(ctx: PaymentsContext, match: Record<string, unknown>, session?: ClientSession | null) {
  const cutoff = holdCutoff(ctx);
  const rows = await ctx.models.LedgerEntry.aggregate<{ _id: { accountId: string; entryType: LedgerEntryType }; total: number; matured: number }>([
    { $match: match },
    {
      $group: {
        _id: { accountId: '$accountId', entryType: '$entryType' },
        total: { $sum: '$amountPaise' },
        // Only positive earnings are held; negative entries reduce availability immediately.
        matured: { $sum: { $cond: [{ $or: [{ $lt: ['$amountPaise', 0] }, { $lte: ['$createdAt', cutoff] }] }, '$amountPaise', 0] } },
      },
    },
  ]).session(session ?? null);
  const out = new Map<string, Rollup>();
  for (const r of rows) {
    const acc = out.get(r._id.accountId) ?? { balance: 0, maturedNonPayout: 0, payoutTotal: 0, totalsByType: {} };
    acc.balance += r.total;
    acc.totalsByType[r._id.entryType] = (acc.totalsByType[r._id.entryType] ?? 0) + r.total;
    if (r._id.entryType === 'PAYOUT') acc.payoutTotal += r.total;
    else acc.maturedNonPayout += r.matured;
    out.set(r._id.accountId, acc);
  }
  return out;
}

async function pendingPayouts(ctx: PaymentsContext, match: Record<string, unknown>, session?: ClientSession | null) {
  const rows = await ctx.models.Payout.aggregate<{ _id: string; total: number }>([
    { $match: { ...match, status: { $in: ['REQUESTED', 'PROCESSING'] } } },
    { $group: { _id: '$accountId', total: { $sum: '$amountPaise' } } },
  ]).session(session ?? null);
  return new Map(rows.map((r) => [r._id, r.total]));
}

function summarize(ctx: PaymentsContext, accountType: LedgerAccountType, accountId: string, r: Rollup | undefined, pending: number): AccountSummary {
  const roll = r ?? { balance: 0, maturedNonPayout: 0, payoutTotal: 0, totalsByType: {} };
  return {
    accountType,
    accountId,
    balancePaise: roll.balance,
    availablePaise: Math.max(0, Math.min(roll.maturedNonPayout + roll.payoutTotal - pending, roll.balance - pending)),
    pendingPayoutPaise: pending,
    paidOutPaise: 0 - roll.payoutTotal, // avoid -0
    holdDays: ctx.config.PAYOUT_HOLD_DAYS,
    totalsByType: roll.totalsByType,
    asOf: ctx.now().toISOString(),
  };
}

export async function accountSummary(
  ctx: PaymentsContext,
  accountType: LedgerAccountType,
  accountId: string,
  session?: ClientSession | null,
): Promise<AccountSummary> {
  const match = { accountType, accountId };
  const [roll, pending] = await Promise.all([rollup(ctx, match, session), pendingPayouts(ctx, match, session)]);
  return summarize(ctx, accountType, accountId, roll.get(accountId), pending.get(accountId) ?? 0);
}

// ---- PAY-1: windowed earnings ----
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
export const MAX_EARNINGS_WINDOW_DAYS = 93;

/** The UTC instant of 00:00 Asia/Kolkata (UTC+05:30, no DST) on the IST calendar day containing `at`. */
export function istDayStart(at: Date): Date {
  return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

export interface EarningsWindow {
  from: string;
  to: string;
  earningsPaise: number;
  entriesByType: Partial<Record<LedgerEntryType, number>>;
  deliveries: number;
}

/**
 * What counts as "earned" in a window (payouts and manual adjustments never do; `entriesByType` still shows every type):
 *   partner    = DELIVERY_EARNING
 *   restaurant = ORDER_EARNING + COMMISSION + REFUND_ADJUSTMENT (net of commission and refunds)
 */
export const EARNED_ENTRY_TYPES: Record<LedgerAccountType, readonly LedgerEntryType[]> = {
  PARTNER: ['DELIVERY_EARNING'],
  RESTAURANT: ['ORDER_EARNING', 'COMMISSION', 'REFUND_ADJUSTMENT'],
  PLATFORM: [],
};

/** Resolve `from`/`to` (default: today in IST, IST midnight to `now`). Window is half-open [from, to). */
export function resolveWindow(now: Date, q: { from?: Date | undefined; to?: Date | undefined }): { from: Date; to: Date } {
  const to = q.to ?? now;
  let from = q.from;
  if (!from) {
    from = istDayStart(to);
    // `to` exactly at IST midnight: the day that just ended, not an empty window.
    if (from.getTime() >= to.getTime()) from = istDayStart(new Date(to.getTime() - 1));
  }
  const bad = (path: string, message: string) => new DomainError('VALIDATION_FAILED', 'Request validation failed', undefined, { issues: [{ path: `query.${path}`, code: 'custom', message }] });
  if (!(from.getTime() < to.getTime())) throw bad('from', '`from` must be before `to`');
  if (to.getTime() - from.getTime() > MAX_EARNINGS_WINDOW_DAYS * DAY_MS) throw bad('to', `window must not exceed ${MAX_EARNINGS_WINDOW_DAYS} days`);
  return { from, to };
}

/** Σ ledger entries of the account created in [from, to), by entry type; `deliveries` = DELIVERY_EARNING entries (one per job). */
async function accountWindow(
  ctx: PaymentsContext,
  accountType: LedgerAccountType,
  accountId: string,
  win: { from: Date; to: Date },
): Promise<EarningsWindow> {
  const { from, to } = win;
  const rows = await ctx.models.LedgerEntry.aggregate<{ _id: LedgerEntryType; total: number; count: number }>([
    { $match: { accountType, accountId, createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$entryType', total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
  ]);
  const earned = EARNED_ENTRY_TYPES[accountType];
  const entriesByType: Partial<Record<LedgerEntryType, number>> = {};
  let earningsPaise = 0;
  let deliveries = 0;
  for (const r of rows) {
    entriesByType[r._id] = r.total;
    if (earned.includes(r._id)) earningsPaise += r.total;
    if (r._id === 'DELIVERY_EARNING') deliveries = r.count;
  }
  return { from: from.toISOString(), to: to.toISOString(), earningsPaise, entriesByType, deliveries };
}

/** Finance summary + PAY-1 window. The window is validated before any read; `asOf` and a defaulted `window.to` share one `now`. */
export async function financeSummary(
  ctx: PaymentsContext,
  accountType: LedgerAccountType,
  accountId: string,
  q: { from?: Date | undefined; to?: Date | undefined },
) {
  const now = ctx.now();
  const win = resolveWindow(now, q);
  const [summary, window] = await Promise.all([accountSummary(ctx, accountType, accountId), accountWindow(ctx, accountType, accountId, win)]);
  return { ...summary, asOf: now.toISOString(), window };
}

/** Admin: balances of every account of a type (sorted by accountId, cursor = last accountId). */
export async function listBalances(ctx: PaymentsContext, accountType: LedgerAccountType, opts: { limit: number; cursor?: string }) {
  const match: Record<string, unknown> = { accountType, ...(opts.cursor ? { accountId: { $gt: opts.cursor } } : {}) };
  const ids = (await ctx.models.LedgerEntry.distinct('accountId', match)).sort().slice(0, opts.limit + 1);
  const page = ids.slice(0, opts.limit);
  const scoped = { accountType, accountId: { $in: page } };
  const [roll, pending] = await Promise.all([rollup(ctx, scoped), pendingPayouts(ctx, scoped)]);
  return {
    items: page.map((id) => summarize(ctx, accountType, id, roll.get(id), pending.get(id) ?? 0)),
    nextCursor: ids.length > opts.limit ? (page[page.length - 1] ?? null) : null,
  };
}

export function ledgerEntryView(e: LedgerEntryAttrs) {
  return {
    id: String(e._id),
    accountType: e.accountType,
    accountId: e.accountId,
    entryType: e.entryType,
    amountPaise: e.amountPaise,
    childOrderId: e.childOrderId ?? null,
    deliveryJobId: e.deliveryJobId ?? null,
    payoutId: e.payoutId ?? null,
    refundId: e.refundId ?? null,
    memo: e.memo,
    isDemo: e.isDemo ?? false,
    createdAt: new Date(e.createdAt).toISOString(),
  };
}
