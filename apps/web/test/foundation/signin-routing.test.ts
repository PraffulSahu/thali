import { describe, expect, it } from 'vitest';
import { destinationAfterSignIn, parseSignInRole, rolesFromSignIn } from '../../src/lib/signin';
import { makeJwt } from '../utils';

describe('parseSignInRole', () => {
  it('defaults to customer and accepts the four roles', () => {
    expect(parseSignInRole(null)).toBe('customer');
    expect(parseSignInRole('restaurant')).toBe('restaurant');
    expect(parseSignInRole('partner')).toBe('partner');
    expect(parseSignInRole('admin')).toBe('admin');
    expect(parseSignInRole('hacker')).toBe('customer');
  });
});

describe('destinationAfterSignIn', () => {
  it('customer → next or /', () => {
    expect(destinationAfterSignIn('customer', ['CONSUMER'], null)).toBe('/');
    expect(destinationAfterSignIn('customer', ['CONSUMER'], '/orders?x=1')).toBe('/orders?x=1');
    expect(destinationAfterSignIn('customer', ['CONSUMER'], '//evil.com')).toBe('/');
  });

  it('restaurant → console when the owner role exists, else onboarding', () => {
    expect(destinationAfterSignIn('restaurant', ['CONSUMER', 'RESTAURANT_OWNER'], null)).toBe('/restaurant');
    expect(destinationAfterSignIn('restaurant', ['CONSUMER'], null)).toBe('/restaurant/onboarding');
    expect(destinationAfterSignIn('restaurant', ['CONSUMER', 'RESTAURANT_OWNER'], '/restaurant/orders')).toBe('/restaurant/orders');
    // a console deep link without the role still goes to onboarding
    expect(destinationAfterSignIn('restaurant', ['CONSUMER'], '/restaurant/orders')).toBe('/restaurant/onboarding');
    expect(destinationAfterSignIn('restaurant', ['CONSUMER'], '/restaurant/onboarding')).toBe('/restaurant/onboarding');
  });

  it('partner → partner home when the role exists, else onboarding', () => {
    expect(destinationAfterSignIn('partner', ['CONSUMER', 'DELIVERY_PARTNER'], null)).toBe('/partner');
    expect(destinationAfterSignIn('partner', ['CONSUMER'], null)).toBe('/partner/onboarding');
    expect(destinationAfterSignIn('partner', ['CONSUMER', 'DELIVERY_PARTNER'], '/partner/earnings')).toBe('/partner/earnings');
  });

  it('admin → only admin paths, never back to the login pages', () => {
    expect(destinationAfterSignIn('admin', ['ADMIN'], null)).toBe('/admin');
    expect(destinationAfterSignIn('admin', ['ADMIN'], '/admin/audit')).toBe('/admin/audit');
    expect(destinationAfterSignIn('admin', ['ADMIN'], '/orders')).toBe('/admin');
    expect(destinationAfterSignIn('admin', ['ADMIN'], '/admin/login')).toBe('/admin');
  });

  it('honours next across areas for a customer tab signing in to a role page', () => {
    expect(destinationAfterSignIn('customer', ['CONSUMER', 'RESTAURANT_OWNER'], '/restaurant/menu')).toBe('/restaurant/menu');
  });
});

describe('rolesFromSignIn', () => {
  it('prefers token claims, then user.roles', () => {
    expect(rolesFromSignIn({ id: 'u', roles: ['CONSUMER'] }, makeJwt({ sub: 'u', roles: ['CONSUMER', 'DELIVERY_PARTNER'] }))).toEqual(['CONSUMER', 'DELIVERY_PARTNER']);
    expect(rolesFromSignIn({ id: 'u', roles: ['CONSUMER'] }, null)).toEqual(['CONSUMER']);
    expect(rolesFromSignIn(null, null)).toEqual([]);
  });
});
