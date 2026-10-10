import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bpsOf, formatINR } from '../src/index.js';
import { seedId } from '../src/seed.js';

describe('money', () => {
  it('bpsOf rounds half up with integer math', () => {
    expect(bpsOf(10000, 500)).toBe(500);
    expect(bpsOf(999, 500)).toBe(50); // 49.95 -> 50
    expect(bpsOf(110, 500)).toBe(6); // 5.5 -> 6
    expect(bpsOf(109, 500)).toBe(5); // 5.45 -> 5
    expect(bpsOf(0, 1800)).toBe(0);
  });

  it('formatINR uses en-IN grouping with two decimals', () => {
    expect(formatINR(123450)).toBe('₹1,234.50');
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(formatINR(-50000)).toBe('-₹500.00');
    expect(() => formatINR(1.5)).toThrow();
  });
});

describe('seedId', () => {
  it('is the first 24 hex chars of sha1("thali-seed:" + name)', () => {
    const expected = createHash('sha1').update('thali-seed:restaurant:1').digest('hex').slice(0, 24);
    expect(seedId('restaurant:1')).toBe(expected);
    expect(seedId('restaurant:1')).toMatch(/^[0-9a-f]{24}$/);
    expect(seedId('a')).not.toBe(seedId('b'));
  });
});
