import { describe, expect, it } from 'vitest';
import { createDemoGeo, createGeoProvider, haversineKm, ConfigError } from '@thali/service-kit';

// Independent haversine for the assertion (R = 6371 km).
function refHaversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const MG_ROAD = { lat: 12.9756, lng: 77.605 };
const INDIRANAGAR = { lat: 12.9719, lng: 77.6412 };

describe('haversineKm', () => {
  it('matches the reference formula', () => {
    expect(haversineKm(MG_ROAD, INDIRANAGAR)).toBeCloseTo(refHaversine(MG_ROAD, INDIRANAGAR), 6);
    expect(haversineKm(MG_ROAD, MG_ROAD)).toBe(0);
  });
});

describe('demo geo (haversine x ROAD_FACTOR 1.3 / AVG_SPEED 20 km/h)', () => {
  it('Bangalore MG Road -> Indiranagar', async () => {
    const geo = createDemoGeo();
    const r = await geo.distanceAndEta(MG_ROAD, INDIRANAGAR);
    const expected = refHaversine(MG_ROAD, INDIRANAGAR) * 1.3;
    expect(r.source).toBe('DEMO_HAVERSINE');
    expect(Math.abs(r.distanceKm - expected) / expected).toBeLessThan(0.05);
    expect(r.etaMinutes).toBe(Math.ceil((r.distanceKm / 20) * 60));
    expect(r.distanceKm).toBeGreaterThan(4.5);
    expect(r.distanceKm).toBeLessThan(5.5);
  });

  it('honours custom road factor and speed', async () => {
    const geo = createDemoGeo({ roadFactor: 1, avgSpeedKmph: 60 });
    const r = await geo.distanceAndEta(MG_ROAD, INDIRANAGAR);
    expect(r.distanceKm).toBeCloseTo(refHaversine(MG_ROAD, INDIRANAGAR), 1);
    expect(r.etaMinutes).toBe(Math.ceil(r.distanceKm));
  });

  it('same point -> zero distance', async () => {
    const r = await createDemoGeo().distanceAndEta(MG_ROAD, MG_ROAD);
    expect(r).toEqual({ distanceKm: 0, etaMinutes: 0, source: 'DEMO_HAVERSINE' });
  });
});

describe('createGeoProvider', () => {
  it('builds the demo provider in demo mode', async () => {
    const geo = createGeoProvider({ GEO_PROVIDER: 'demo', APP_MODE: 'demo', SERVICE_NAME: 'delivery' });
    expect((await geo.distanceAndEta(MG_ROAD, INDIRANAGAR)).source).toBe('DEMO_HAVERSINE');
  });

  it('refuses the demo provider in production', () => {
    expect(() => createGeoProvider({ GEO_PROVIDER: 'demo', APP_MODE: 'production', SERVICE_NAME: 'delivery' })).toThrow(ConfigError);
  });

  it('requires an API key for google', () => {
    expect(() => createGeoProvider({ GEO_PROVIDER: 'google', APP_MODE: 'sandbox', SERVICE_NAME: 'delivery' })).toThrow(ConfigError);
  });
});
