/** Infra-free test fixtures shared by unit and integration tests. */
import { createHmac, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

export const ENC_KEY = randomBytes(32).toString('base64');
export const TWILIO_URL = 'https://api.thali.test/api/v1/webhooks/twilio/status';
export const TWILIO_TOKEN = 'twilio-auth-token-for-tests';
export const RESEND_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
export const oid = () => randomBytes(12).toString('hex');

/** Independent re-implementation of Twilio's algorithm (fullUrl + sorted key+value, HMAC-SHA1, base64). */
export const twilioSign = (url: string, params: Record<string, string>, token = TWILIO_TOKEN) =>
  createHmac('sha1', token)
    .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(''), 'utf8')
    .digest('base64');

/** Independent Svix signer: base64(HMAC-SHA256(base64decode(secret after whsec_), `${id}.${ts}.${body}`)). */
export const svixHeaders = (body: string, opts: { id?: string; ts?: number; secret?: string } = {}) => {
  const id = opts.id ?? `msg_${oid()}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? RESEND_SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
};

export class LogCapture extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.text += chunk.toString();
    cb();
  }
}
