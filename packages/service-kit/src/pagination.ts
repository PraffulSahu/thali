/**
 * Cursor pagination (LLD 1.3): `?limit=20&cursor=<opaque>` → `{ items, nextCursor }`.
 * Cursor = base64url(JSON `{ c: createdAt ISO, i: _id hex }`); sort `createdAt desc, _id desc`.
 *
 * @example
 *   const { limit, cursor } = PaginationQuerySchema.parse(req.query);
 *   const docs = await Order.find({ userId, ...cursorFilter(cursor) }).sort(PAGE_SORT).limit(limit + 1).lean();
 *   res.json(buildPage(docs, limit, toView));
 */
import { Types } from 'mongoose';
import { DomainError, type Paginated } from '@thali/contracts';

export interface CursorPosition {
  createdAt: Date;
  _id: Types.ObjectId;
}

export const PAGE_SORT = { createdAt: -1, _id: -1 } as const;

export function encodeCursor(pos: { createdAt: Date; _id: Types.ObjectId | string }): string {
  const id = typeof pos._id === 'string' ? pos._id : pos._id.toHexString();
  return Buffer.from(JSON.stringify({ c: pos.createdAt.toISOString(), i: id }), 'utf8').toString('base64url');
}

const invalid = () => new DomainError('VALIDATION_FAILED', 'Invalid cursor', undefined, {
  issues: [{ path: 'query.cursor', code: 'invalid_format', message: 'Invalid cursor' }],
});

export function decodeCursor(cursor: string): CursorPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { c, i } = (parsed ?? {}) as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || !/^[0-9a-f]{24}$/i.test(i)) throw invalid();
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, _id: new Types.ObjectId(i) };
}

/** Mongo filter selecting rows strictly after the cursor in `PAGE_SORT` order (`{}` when absent). */
export function cursorFilter(cursor: string | undefined | null): Record<string, unknown> {
  if (!cursor) return {};
  const { createdAt, _id } = decodeCursor(cursor);
  return { $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: _id } }] };
}

/**
 * Build a page from `limit + 1` rows fetched in `PAGE_SORT` order. `nextCursor` points at the last
 * returned row when a lookahead row exists, else `null`.
 */
export function buildPage<D extends { createdAt: Date; _id: Types.ObjectId | string }, T = D>(
  docs: D[],
  limit: number,
  map?: (doc: D) => T,
): Paginated<T> {
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((d) => (map ? map(d) : (d as unknown as T))),
    nextCursor: docs.length > limit && last ? encodeCursor(last) : null,
  };
}
