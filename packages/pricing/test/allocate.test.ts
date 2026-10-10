import { describe, expect, it } from 'vitest';
import { allocateProRata } from '../src/index.js';

describe('allocateProRata', () => {
  it('splits a tie so the remainder goes to the smallest key', () => {
    expect(
      allocateProRata(100, [
        { key: 'a', weight: 1 },
        { key: 'b', weight: 1 },
        { key: 'c', weight: 1 },
      ]),
    ).toEqual({ a: 34, b: 33, c: 33 });
  });

  it('breaks ties by key ascending regardless of input order', () => {
    expect(
      allocateProRata(100, [
        { key: 'c', weight: 1 },
        { key: 'a', weight: 1 },
        { key: 'b', weight: 1 },
      ]),
    ).toEqual({ a: 34, b: 33, c: 33 });
  });

  it('allocates zero total as all zeros', () => {
    expect(
      allocateProRata(0, [
        { key: 'a', weight: 3 },
        { key: 'b', weight: 7 },
      ]),
    ).toEqual({ a: 0, b: 0 });
  });

  it('gives everything to the first key (key ascending) when all weights are zero', () => {
    expect(
      allocateProRata(10, [
        { key: 'b', weight: 0 },
        { key: 'a', weight: 0 },
      ]),
    ).toEqual({ a: 10, b: 0 });
  });

  it('allocates exactly proportionally when divisible', () => {
    expect(
      allocateProRata(1000, [
        { key: 'a', weight: 3000 },
        { key: 'b', weight: 7000 },
      ]),
    ).toEqual({ a: 300, b: 700 });
  });

  it('gives the remainder to the largest fractional part', () => {
    // T=10, w=[1,2]: a=3.33 (frac 10 mod 3 = 1), b=6.67 (frac 20 mod 3 = 2) -> floors 3,6, R=1 -> b
    expect(
      allocateProRata(10, [
        { key: 'a', weight: 1 },
        { key: 'b', weight: 2 },
      ]),
    ).toEqual({ a: 3, b: 7 });
  });

  it('returns an empty record for no weights and zero total', () => {
    expect(allocateProRata(0, [])).toEqual({});
  });

  it('rejects invalid input with RangeError', () => {
    const w = [{ key: 'a', weight: 1 }];
    expect(() => allocateProRata(-1, w)).toThrow(RangeError);
    expect(() => allocateProRata(1.5, w)).toThrow(RangeError);
    expect(() => allocateProRata(Number.NaN, w)).toThrow(RangeError);
    expect(() => allocateProRata(1, [{ key: 'a', weight: -1 }])).toThrow(RangeError);
    expect(() => allocateProRata(1, [{ key: 'a', weight: 0.5 }])).toThrow(RangeError);
    expect(() =>
      allocateProRata(1, [
        { key: 'a', weight: 1 },
        { key: 'a', weight: 1 },
      ]),
    ).toThrow(RangeError);
    expect(() => allocateProRata(1, [])).toThrow(RangeError);
  });
});
