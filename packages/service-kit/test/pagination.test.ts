import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { DomainError } from '@thali/contracts';
import { buildPage, cursorFilter, decodeCursor, encodeCursor, PAGE_SORT } from '@thali/service-kit';

const id = new mongoose.Types.ObjectId();
const createdAt = new Date('2026-10-10T05:30:00.000Z');

describe('cursor pagination (LLD 1.3)', () => {
  it('round-trips { createdAt, _id } as an opaque base64url string', () => {
    const c = encodeCursor({ createdAt, _id: id });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    const d = decodeCursor(c);
    expect(d.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(d._id.toHexString()).toBe(id.toHexString());
  });

  it('accepts string ids', () => {
    expect(decodeCursor(encodeCursor({ createdAt, _id: id.toHexString() }))._id.equals(id)).toBe(true);
  });

  it('rejects malformed cursors with VALIDATION_FAILED', () => {
    for (const bad of ['%%%', 'abc', Buffer.from('{"c":"nope","i":"x"}').toString('base64url')]) {
      try {
        decodeCursor(bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe('VALIDATION_FAILED');
      }
    }
  });

  it('cursorFilter builds the (createdAt desc, _id desc) keyset filter', () => {
    expect(cursorFilter(undefined)).toEqual({});
    const f = cursorFilter(encodeCursor({ createdAt, _id: id }));
    expect(f).toEqual({
      $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }],
    });
    expect(PAGE_SORT).toEqual({ createdAt: -1, _id: -1 });
  });

  it('buildPage trims the lookahead row and sets nextCursor from the last item', () => {
    const docs = [0, 1, 2].map((i) => ({ _id: new mongoose.Types.ObjectId(), createdAt: new Date(Date.UTC(2026, 9, 10 - i)), n: i }));
    const page = buildPage(docs, 2, (d) => ({ n: d.n }));
    expect(page.items).toEqual([{ n: 0 }, { n: 1 }]);
    expect(decodeCursor(page.nextCursor!)._id.equals(docs[1]!._id)).toBe(true);

    const last = buildPage(docs.slice(0, 2), 2);
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });
});
