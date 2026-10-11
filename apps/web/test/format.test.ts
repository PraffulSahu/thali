import './setup';
import { describe, expect, it } from 'vitest';
import { formatBps, formatDate, formatDateTime, formatDuration, formatPhone, formatRelative, formatTime } from '../src/lib/format';
import { errorMessage, fieldErrors, ApiError } from '../src/lib/errors';
import { googleMapsDirectionsUrl, haversineKm } from '../src/lib/geo';
import { decodeJwt } from '../src/lib/jwt';
import { makeJwt } from './utils';

describe('format', () => {
  it('renders dates in Asia/Kolkata regardless of device timezone', () => {
    // 20:00 UTC on the 9th is 01:30 IST on the 10th.
    const iso = '2026-10-09T20:00:00Z';
    expect(formatDate(iso)).toBe('10 Oct 2026');
    expect(formatTime(iso)).toBe('1:30 AM');
    expect(formatDateTime(iso).toLowerCase()).toContain('10 oct 2026');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    expect(formatRelative('2026-10-10T09:59:48Z', now)).toBe('12s ago');
    expect(formatRelative('2026-10-10T09:55:00Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-10-10T10:03:00Z', now)).toBe('in 3 min');
    expect(formatRelative('2026-10-10T09:59:58Z', now)).toBe('just now');
  });

  it('formats durations, phones and bps', () => {
    expect(formatDuration(299)).toBe('4:59');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatBps(500)).toBe('5%');
    expect(formatBps(1250)).toBe('12.5%');
  });
});

describe('errors', () => {
  it('maps validation issues to field errors without the body. prefix', () => {
    const e = new ApiError({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'Request validation failed',
      details: { issues: [{ path: 'body.phone', code: 'custom', message: 'Invalid phone' }, { path: 'body.address.pincode', code: 'x', message: 'Required' }] },
    });
    expect(fieldErrors(e)).toEqual({ phone: 'Invalid phone', 'address.pincode': 'Required' });
  });

  it('uses friendly copy for network/5xx and the server message for business 4xx', () => {
    expect(errorMessage(new ApiError({ code: 'NETWORK_ERROR', status: 0, message: 'x' }))).toMatch(/offline/i);
    expect(errorMessage(new ApiError({ code: 'INTERNAL_ERROR', status: 500, message: 'boom' }))).toMatch(/something went wrong/i);
    expect(errorMessage(new ApiError({ code: 'RESTAURANT_CLOSED', status: 422, message: 'Biryani House is closed' }))).toBe('Biryani House is closed');
  });
});

describe('geo + jwt', () => {
  it('computes distance and navigation links', () => {
    expect(haversineKm({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9716, lng: 77.6046 })).toBeCloseTo(1.08, 1);
    expect(googleMapsDirectionsUrl({ lat: 12.97, lng: 77.59 })).toBe('https://www.google.com/maps/dir/?api=1&destination=12.97%2C77.59');
  });

  it('decodes access-token claims', () => {
    expect(decodeJwt(makeJwt({ sub: 'u1', roles: ['CONSUMER'], amr: ['otp'] }))).toMatchObject({ sub: 'u1', roles: ['CONSUMER'] });
    expect(decodeJwt('garbage')).toBeNull();
  });
});
