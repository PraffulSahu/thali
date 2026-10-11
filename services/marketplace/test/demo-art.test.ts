/**
 * Seed realism 3c: the demo restaurant covers and the demo banner carry no baked-in "DEMO" text — the web's
 * Demo badge (RestaurantCard / banner) is the one honest label, so the art no longer clashes with it.
 */
import { describe, expect, it } from 'vitest';
import { demoBannerSvg, demoCoverSvgs } from '../src/seed.js';

describe('demo art', () => {
  it('restaurant covers keep the name but no DEMO text', () => {
    const covers = demoCoverSvgs();
    expect(covers.length).toBeGreaterThanOrEqual(4);
    for (const { name, svg } of covers) {
      expect(svg).toContain(name.replace(/&/g, '&amp;'));
      expect(svg).not.toMatch(/>\s*DEMO\s*</i);
    }
  });

  it('the WELCOME50 banner keeps its offer copy but no DEMO text', () => {
    const svg = demoBannerSvg();
    expect(svg).toContain('WELCOME50');
    expect(svg).not.toMatch(/>\s*DEMO\s*</i);
  });
});
