/** Internal routes (service token): OTP send (identity) and generic send (identity/marketplace/orders/payments/delivery). */
import express, { type Router } from 'express';
import { z } from 'zod';
import { DomainError, normalizePhone } from '@thali/contracts';
import { requireInternal, validate } from '@thali/service-kit';
import type { Dispatcher } from '../domain/dispatcher.js';
import type { RecipientDirectory } from '../domain/recipients.js';
import { isTemplateName } from '../domain/templates.js';
import { OtpBody, SendBody } from '../openapi.js';

const EmailSchema = z.email().max(254);

export function internalRouter(deps: { dispatcher: Dispatcher; directory: RecipientDirectory }): Router {
  const { dispatcher, directory } = deps;
  const r = express.Router();
  const vOtp = validate({ body: OtpBody });
  const vSend = validate({ body: SendBody });

  r.post('/otp', requireInternal(['identity']), vOtp, async (req, res) => {
    const { phone, code } = vOtp.get(req).body;
    const { id } = await dispatcher.sendOtp(phone, code); // throws 503 OTP_DELIVERY_FAILED
    res.status(202).json({ notificationId: id });
  });

  r.post('/send', requireInternal(['identity', 'marketplace', 'orders', 'payments', 'delivery']), vSend, async (req, res) => {
    const b = vSend.get(req).body;
    if (!isTemplateName(b.template) || b.template === 'otp') {
      throw new DomainError('VALIDATION_FAILED', b.template === 'otp' ? 'OTPs are sent through /internal/notifications/otp' : `Unknown template '${b.template}'`);
    }
    let to: string | undefined;
    if (b.channel !== 'IN_APP') {
      if (b.to) {
        to = b.channel === 'SMS' ? normalizePhone(b.to) : EmailSchema.parse(b.to).toLowerCase();
      } else if (b.userId) {
        const user = await directory.getUser(b.userId);
        if (!user) throw new DomainError('NOT_FOUND', 'Recipient user not found');
        to = (b.channel === 'SMS' ? user.phone : user.email) ?? undefined;
        if (!to) throw new DomainError('VALIDATION_FAILED', `Recipient has no ${b.channel === 'SMS' ? 'phone number' : 'email address'}`);
      } else {
        throw new DomainError('VALIDATION_FAILED', `${b.channel} notifications need "to" or "userId"`);
      }
    } else if (!b.userId) {
      throw new DomainError('VALIDATION_FAILED', 'IN_APP notifications need "userId"');
    }
    const { id } = await dispatcher.enqueue({ channel: b.channel, template: b.template, data: b.data, dedupeKey: b.dedupeKey, userId: b.userId, to });
    dispatcher.kick([id]);
    res.status(202).json({ notificationId: id });
  });

  return r;
}
