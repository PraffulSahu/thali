import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleGeo, haversineKm } from '@thali/service-kit';

const FROM = { lat: 12.9756, lng: 77.605 };
const TO = { lat: 12.9719, lng: 77.6412 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('google geo (Routes API computeRoutes)', () => {
  it('sends the documented request and maps the response', async () => {
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify({ routes: [{ distanceMeters: 5230, duration: '1234s' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const errors: string[] = [];
    const geo = createGoogleGeo({ apiKey: 'test-key', mode: 'sandbox', recordError: async (p) => void errors.push(p) });
    const r = await geo.distanceAndEta(FROM, TO);
    expect(r).toEqual({ distanceKm: 5.23, etaMinutes: 21, source: 'GOOGLE' });
    expect(errors).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Goog-Api-Key')).toBe('test-key');
    expect(headers.get('X-Goog-FieldMask')).toBe('routes.duration,routes.distanceMeters');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      origin: { location: { latLng: { latitude: FROM.lat, longitude: FROM.lng } } },
      destination: { location: { latLng: { latitude: TO.lat, longitude: TO.lng } } },
      travelMode: 'TWO_WHEELER',
      units: 'METRIC',
    });
  });

  it('allows DRIVE travel mode', async () => {
    const fetchMock = stubFetch(async () => new Response(JSON.stringify({ routes: [{ distanceMeters: 1000, duration: '60s' }] })));
    await createGoogleGeo({ apiKey: 'k', mode: 'demo', travelMode: 'DRIVE' }).distanceAndEta(FROM, TO);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).travelMode).toBe('DRIVE');
  });

  it('on HTTP 500 falls back to haversine labelled DEMO_HAVERSINE in sandbox and records a provider error', async () => {
    stubFetch(async () => new Response('{"error":{"code":500}}', { status: 500 }));
    const errors: string[] = [];
    const geo = createGoogleGeo({ apiKey: 'k', mode: 'sandbox', recordError: async (p) => void errors.push(p) });
    const r = await geo.distanceAndEta(FROM, TO);
    expect(r.source).toBe('DEMO_HAVERSINE');
    const expected = haversineKm(FROM, TO) * 1.3;
    expect(r.distanceKm).toBeCloseTo(expected, 1);
    expect(r.etaMinutes).toBe(Math.ceil((r.distanceKm / 20) * 60));
    expect(errors).toEqual(['google-routes']);
  });

  it('in production the fallback is labelled HAVERSINE_FALLBACK (never pretends to be Google or demo)', async () => {
    stubFetch(async () => new Response('nope', { status: 503 }));
    const errors: string[] = [];
    const r = await createGoogleGeo({ apiKey: 'k', mode: 'production', recordError: async (p) => void errors.push(p) }).distanceAndEta(FROM, TO);
    expect(r.source).toBe('HAVERSINE_FALLBACK');
    expect(errors).toEqual(['google-routes']);
  });

  it('falls back when no route is returned (empty body)', async () => {
    stubFetch(async () => new Response('{}', { status: 200 }));
    const errors: string[] = [];
    const r = await createGoogleGeo({ apiKey: 'k', mode: 'demo', recordError: async (p) => void errors.push(p) }).distanceAndEta(FROM, TO);
    expect(r.source).toBe('DEMO_HAVERSINE');
    expect(errors).toHaveLength(1);
  });

  it('times out (default 5 s; configurable) and falls back', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const errors: string[] = [];
    const t0 = Date.now();
    const r = await createGoogleGeo({ apiKey: 'k', mode: 'sandbox', timeoutMs: 50, recordError: async (p) => void errors.push(p) }).distanceAndEta(FROM, TO);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.source).toBe('DEMO_HAVERSINE');
    expect(errors).toEqual(['google-routes']);
  });

  it('still answers when recording the provider error itself fails', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await createGoogleGeo({
      apiKey: 'k',
      mode: 'sandbox',
      recordError: async () => {
        throw new Error('redis down');
      },
    }).distanceAndEta(FROM, TO);
    expect(r.source).toBe('DEMO_HAVERSINE');
  });

  it('geocode maps the Geocoding API response', async () => {
    const fetchMock = stubFetch(async () =>
      new Response(
        JSON.stringify({
          status: 'OK',
          results: [{ formatted_address: 'MG Road, Bengaluru', geometry: { location: { lat: 12.9756, lng: 77.605 } } }],
        }),
      ),
    );
    const geo = createGoogleGeo({ apiKey: 'k', mode: 'sandbox' });
    expect(await geo.geocode!('MG Road Bangalore')).toEqual({ lat: 12.9756, lng: 77.605, formattedAddress: 'MG Road, Bengaluru' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(url.searchParams.get('address')).toBe('MG Road Bangalore');
    expect(url.searchParams.get('key')).toBe('k');
  });

  it('geocode returns null for ZERO_RESULTS', async () => {
    stubFetch(async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] })));
    expect(await createGoogleGeo({ apiKey: 'k', mode: 'sandbox' }).geocode!('nowhere')).toBeNull();
  });
});
