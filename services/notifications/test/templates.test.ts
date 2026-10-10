import { describe, expect, it } from 'vitest';
import { renderTemplate, TEMPLATE_NAMES, TEMPLATES, formatInr, maskPhone, maskEmail } from '../src/domain/templates.js';

describe('templates', () => {
  it('exposes every template required by the brief', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(
      [
        'otp', 'order_placed_customer', 'order_placed_restaurant', 'order_accepted', 'order_rejected', 'order_cancelled',
        'order_out_for_delivery', 'order_delivered', 'refund_succeeded', 'restaurant_email_verification',
        'restaurant_status_changed', 'partner_status_changed', 'delivery_exception_admin', 'membership_activated',
        'restaurant_submitted_admin',
      ].sort(),
    );
  });

  it('formats paise as rupees without floats', () => {
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(25000)).toBe('₹250.00');
    expect(formatInr(123456789)).toBe('₹12,34,567.89'); // Indian digit grouping
  });

  it('order_rejected states the refund amount and that other restaurants continue', () => {
    const sms = renderTemplate('order_rejected', { code: 'TH-ABC', reason: 'Out of paneer', refundPaise: 25000 }, 'SMS');
    expect(sms.text).toContain('₹250.00');
    expect(sms.text.toLowerCase()).toContain('other restaurants');
    expect(sms.text.length).toBeLessThanOrEqual(320);
    const email = renderTemplate('order_rejected', { reason: 'Out of paneer', refundPaise: 25000 }, 'EMAIL');
    expect(email.subject).toBeTruthy();
    expect(email.html).toContain('₹250.00');
    expect(email.html.toLowerCase()).toContain('other restaurants');
  });

  it('escapes HTML in every interpolated value', () => {
    const r = renderTemplate('restaurant_status_changed', { name: '<script>alert(1)</script>', from: 'A', to: 'REJECTED', reason: '"><img src=x onerror=1>' }, 'EMAIL');
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('otp is SMS-only and contains the code; verification email contains the URL in both parts', () => {
    expect(TEMPLATES.otp.channels).toEqual(['SMS']);
    expect(renderTemplate('otp', { code: '123456' }, 'SMS').text).toContain('123456');
    const e = renderTemplate('restaurant_email_verification', { verifyUrl: 'https://x.test/v?token=a&b=c' }, 'EMAIL');
    expect(e.text).toContain('https://x.test/v?token=a&b=c');
    expect(e.html).toContain('https://x.test/v?token=a&amp;b=c');
  });

  it('declares secret keys so they are encrypted at rest', () => {
    expect(TEMPLATES.restaurant_email_verification.secretKeys).toEqual(['verifyUrl']);
    expect(TEMPLATES.otp.secretKeys).toEqual(['code']);
  });

  it('tolerates missing data without throwing or printing "undefined"', () => {
    for (const name of TEMPLATE_NAMES) {
      for (const ch of TEMPLATES[name].channels) {
        const r = renderTemplate(name, {}, ch);
        expect(r.text).not.toContain('undefined');
        expect(r.text).not.toContain('NaN');
      }
    }
  });

  it('masks recipients for display', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
    expect(maskEmail('asha@example.com')).toBe('a***@example.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });
});
