import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@thali/contracts';
import { createDemoGeo, createGoogleGeo, GOOGLE_PLACES_AUTOCOMPLETE_URL, GOOGLE_PLACE_DETAILS_FIELD_MASK } from '@thali/service-kit';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function geoWithErrors(extra: Record<string, unknown> = {}) {
  const errors: { provider: string; message: string }[] = [];
  const geo = createGoogleGeo({
    apiKey: 'test-key',
    mode: 'sandbox',
    recordError: async (provider, err) => void errors.push({ provider, message: err instanceof Error ? err.message : String(err) }),
    ...extra,
  });
  return { geo, errors };
}

const BIAS = { lat: 12.9719, lng: 77.6412 };

describe('google places autocomplete (Places API New)', () => {
  it('POSTs places:autocomplete with key, region, bias and session token; maps predictions', async () => {
    const fetchMock = stubFetch(async () =>
      json({
        suggestions: [
          {
            placePrediction: {
              place: 'places/ChIJ1',
              placeId: 'ChIJ1',
              text: { text: '12th Main Rd, Indiranagar, Bengaluru, Karnataka, India' },
              structuredFormat: { mainText: { text: '12th Main Rd' }, secondaryText: { text: 'Indiranagar, Bengaluru, Karnataka, India' } },
            },
          },
          { queryPrediction: { text: { text: 'biryani near me' } } },
          { placePrediction: { placeId: 'ChIJ2', text: { text: 'Koramangala, Bengaluru' } } },
        ],
      }),
    );
    const { geo, errors } = geoWithErrors();
    const out = await geo.autocomplete!('12th main', { location: BIAS, radiusM: 5000, sessionToken: 'sess-1' });
    expect(out).toEqual([
      { id: 'ChIJ1', primary: '12th Main Rd', secondary: 'Indiranagar, Bengaluru, Karnataka, India', locality: null, city: null, pincode: null, location: null },
      { id: 'ChIJ2', primary: 'Koramangala, Bengaluru', secondary: '', locality: null, city: null, pincode: null, location: null },
    ]);
    expect(errors).toEqual([]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GOOGLE_PLACES_AUTOCOMPLETE_URL);
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init.headers);
    expect(h.get('X-Goog-Api-Key')).toBe('test-key');
    expect(h.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      input: '12th main',
      includedRegionCodes: ['in'],
      sessionToken: 'sess-1',
      locationBias: { circle: { center: { latitude: BIAS.lat, longitude: BIAS.lng }, radius: 5000 } },
    });
  });

  it('omits bias/session when not given; empty suggestions → []', async () => {
    const fetchMock = stubFetch(async () => json({}));
    const { geo } = geoWithErrors();
    expect(await geo.autocomplete!('xy')).toEqual([]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ input: 'xy', includedRegionCodes: ['in'] });
  });

  it('on failure records google-places (with a message) and throws UPSTREAM_UNAVAILABLE', async () => {
    stubFetch(async () => json({ error: { code: 403 } }, 403));
    const { geo, errors } = geoWithErrors();
    await expect(geo.autocomplete!('abc')).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === 'UPSTREAM_UNAVAILABLE');
    expect(errors).toEqual([{ provider: 'google-places', message: 'google-places: HTTP 403' }]);
  });

  it('times out with the adapter timeout', async () => {
    stubFetch((_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const { geo, errors } = geoWithErrors({ timeoutMs: 50 });
    await expect(geo.autocomplete!('abc')).rejects.toBeInstanceOf(DomainError);
    expect(errors[0]!.provider).toBe('google-places');
    expect(errors[0]!.message).toMatch(/timed out/);
  });
});

describe('google place details (Places API New)', () => {
  const place = {
    id: 'ChIJ1',
    formattedAddress: '12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038, India',
    location: { latitude: 12.9719, longitude: 77.6412 },
    addressComponents: [
      { longText: '12th Main Road', shortText: '12th Main Rd', types: ['route'] },
      { longText: 'Indiranagar', shortText: 'Indiranagar', types: ['sublocality_level_1', 'sublocality', 'political'] },
      { longText: 'Bengaluru', shortText: 'Bengaluru', types: ['locality', 'political'] },
      { longText: '560038', shortText: '560038', types: ['postal_code'] },
    ],
  };

  it('GETs places/{id} with field mask + session token and maps the place', async () => {
    const fetchMock = stubFetch(async () => json(place));
    const { geo } = geoWithErrors();
    expect(await geo.placeDetails!('ChIJ1', { sessionToken: 'sess-1' })).toEqual({
      id: 'ChIJ1',
      formattedAddress: place.formattedAddress,
      locality: 'Indiranagar',
      city: 'Bengaluru',
      pincode: '560038',
      location: { lat: 12.9719, lng: 77.6412 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://places.googleapis.com/v1/places/ChIJ1');
    expect(u.searchParams.get('sessionToken')).toBe('sess-1');
    expect(u.searchParams.get('key')).toBeNull(); // key travels in the header only
    const h = new Headers(init.headers);
    expect(h.get('X-Goog-Api-Key')).toBe('test-key');
    expect(h.get('X-Goog-FieldMask')).toBe(GOOGLE_PLACE_DETAILS_FIELD_MASK);
    expect(GOOGLE_PLACE_DETAILS_FIELD_MASK).toBe('id,formattedAddress,location,addressComponents');
  });

  it('encodes the place id in the path', async () => {
    const fetchMock = stubFetch(async () => json(place));
    await geoWithErrors().geo.placeDetails!('a/b?c');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/places/a%2Fb%3Fc');
  });

  it('404 → null without recording a provider error', async () => {
    stubFetch(async () => json({ error: { code: 404 } }, 404));
    const { geo, errors } = geoWithErrors();
    expect(await geo.placeDetails!('nope')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('400 INVALID_ARGUMENT (malformed place id, caller input) → null without recording a provider error', async () => {
    stubFetch(async () => json({ error: { code: 400, message: 'Not a valid Place ID', status: 'INVALID_ARGUMENT' } }, 400));
    const { geo, errors } = geoWithErrors();
    expect(await geo.placeDetails!('!!garbage!!')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('5xx or a place without a location → google-places error + UPSTREAM_UNAVAILABLE', async () => {
    stubFetch(async () => json({}, 500));
    const a = geoWithErrors();
    await expect(a.geo.placeDetails!('x')).rejects.toBeInstanceOf(DomainError);
    expect(a.errors.map((e) => e.provider)).toEqual(['google-places']);

    stubFetch(async () => json({ id: 'x', formattedAddress: 'y' }));
    const b = geoWithErrors();
    await expect(b.geo.placeDetails!('x')).rejects.toBeInstanceOf(DomainError);
    expect(b.errors.map((e) => e.provider)).toEqual(['google-places']);
  });
});

describe('google reverse geocode (Geocoding API)', () => {
  it('GETs geocode/json?latlng= and builds a short label', async () => {
    const fetchMock = stubFetch(async () =>
      json({
        status: 'OK',
        results: [
          {
            formatted_address: '640, 12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038, India',
            geometry: { location: { lat: 12.97191, lng: 77.64123 } },
            address_components: [
              { long_name: '640', short_name: '640', types: ['street_number'] },
              { long_name: '12th Main Road', short_name: '12th Main Rd', types: ['route'] },
              { long_name: 'HAL 2nd Stage', short_name: 'HAL 2nd Stage', types: ['sublocality_level_2', 'sublocality', 'political'] },
              { long_name: 'Indiranagar', short_name: 'Indiranagar', types: ['sublocality_level_1', 'sublocality', 'political'] },
              { long_name: 'Bengaluru', short_name: 'Bengaluru', types: ['locality', 'political'] },
              { long_name: '560038', short_name: '560038', types: ['postal_code'] },
            ],
          },
        ],
      }),
    );
    const { geo } = geoWithErrors();
    expect(await geo.reverse!({ lat: 12.9719, lng: 77.6412 })).toEqual({
      label: '12th Main Rd, Indiranagar',
      formattedAddress: '640, 12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038, India',
      locality: 'Indiranagar',
      city: 'Bengaluru',
      pincode: '560038',
      location: { lat: 12.97191, lng: 77.64123 },
    });
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.origin + u.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(u.searchParams.get('latlng')).toBe('12.9719,77.6412');
    expect(u.searchParams.get('key')).toBe('test-key');
  });

  it('label falls back to locality, city when there is no route', async () => {
    stubFetch(async () =>
      json({
        status: 'OK',
        results: [
          {
            formatted_address: 'Koramangala, Bengaluru, Karnataka, India',
            geometry: { location: { lat: 12.93, lng: 77.62 } },
            address_components: [
              { long_name: 'Koramangala', short_name: 'Koramangala', types: ['sublocality_level_1', 'sublocality', 'political'] },
              { long_name: 'Bengaluru', short_name: 'Bengaluru', types: ['locality', 'political'] },
            ],
          },
        ],
      }),
    );
    const r = await geoWithErrors().geo.reverse!({ lat: 12.93, lng: 77.62 });
    expect(r).toMatchObject({ label: 'Koramangala, Bengaluru', locality: 'Koramangala', city: 'Bengaluru', pincode: null });
  });

  it('label falls back to the formatted address (first two parts) when there is a route but no locality', async () => {
    stubFetch(async () =>
      json({
        status: 'OK',
        results: [
          {
            formatted_address: 'NH 44, Devanahalli, Karnataka 562110, India',
            geometry: { location: { lat: 13.2, lng: 77.7 } },
            address_components: [
              { long_name: 'National Highway 44', short_name: 'NH 44', types: ['route'] },
              { long_name: '562110', short_name: '562110', types: ['postal_code'] },
            ],
          },
        ],
      }),
    );
    const r = await geoWithErrors().geo.reverse!({ lat: 13.2, lng: 77.7 });
    expect(r).toMatchObject({ label: 'NH 44, Devanahalli', locality: null, city: null, pincode: '562110' });
  });

  it('ZERO_RESULTS → null; transport failure → google-geocode error + UPSTREAM_UNAVAILABLE', async () => {
    stubFetch(async () => json({ status: 'ZERO_RESULTS', results: [] }));
    expect(await geoWithErrors().geo.reverse!({ lat: 0, lng: 0 })).toBeNull();

    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const { geo, errors } = geoWithErrors();
    await expect(geo.reverse!({ lat: 1, lng: 1 })).rejects.toBeInstanceOf(DomainError);
    expect(errors.map((e) => e.provider)).toEqual(['google-geocode']);
  });

  it('REQUEST_DENIED → google-geocode error + UPSTREAM_UNAVAILABLE', async () => {
    stubFetch(async () => json({ status: 'REQUEST_DENIED', error_message: 'API key invalid' }));
    const { geo, errors } = geoWithErrors();
    await expect(geo.reverse!({ lat: 1, lng: 1 })).rejects.toBeInstanceOf(DomainError);
    expect(errors).toEqual([{ provider: 'google-geocode', message: 'status REQUEST_DENIED' }]);
  });
});

describe('demo geo adapter', () => {
  it('leaves autocomplete / placeDetails / reverse undefined (marketplace falls back to its gazetteer)', () => {
    const g = createDemoGeo();
    expect(g.autocomplete).toBeUndefined();
    expect(g.placeDetails).toBeUndefined();
    expect(g.reverse).toBeUndefined();
  });
});

describe('default recorder passes the error message to recordProviderError', () => {
  it('calls redis with a message argument', async () => {
    stubFetch(async () => json({}, 500));
    const calls: unknown[][] = [];
    // minimal fake redis covering the recorder's multi/eval surface
    const fake = {
      multi() {
        const chain = { zadd: () => chain, zremrangebyscore: () => chain, pexpire: () => chain, exec: async () => [] };
        return chain;
      },
      eval: async (...args: unknown[]) => void calls.push(args),
    };
    const geo = createGoogleGeo({ apiKey: 'k', mode: 'sandbox', redis: fake as never, service: 'marketplace' });
    await geo.distanceAndEta(BIAS, { lat: 12.98, lng: 77.6 });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain('google-routes: HTTP 500');
  });
});
