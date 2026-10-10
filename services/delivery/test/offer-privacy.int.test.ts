/**
 * DLV-2 offer privacy: a partner who is only OFFERED a job learns the drop *area* and the distance
 * from pickup, never the customer's name, address line, label or exact drop coordinates. After
 * assignment the label appears; the full drop address and coordinates appear from PICKED_UP onward.
 */
import request from 'supertest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { at, bearer, createJob, createPartner, setup, type Harness } from './helpers.js';

const CUSTOMER = 'Ananya Iyer';
const LINE = '#402, 12th Main, HAL 2nd Stage, near CMH Rd, Bengaluru, 560038';
const DROP = at(2.2, 3.1);

/** Tokens that must never reach an offered (not assigned) partner. */
function secrets() {
  return [CUSTOMER, 'Ananya', '#402', '12th Main', 'CMH Rd', LINE, 'Home', String(DROP.lat).slice(0, 8), String(DROP.lng).slice(0, 8), '43210'];
}

describe('DLV-2 offer privacy', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('offer_privacy');
  });
  afterAll(async () => h.cleanup());

  async function offered(drop: Record<string, unknown> = { area: 'HAL 2nd Stage', label: 'Home' }) {
    await h.ctx.models.Partner.updateMany({}, { $set: { online: false } });
    const p = await createPartner(h, { location: at(0.1, 0) });
    const base = { name: CUSTOMER, address: LINE, location: { type: 'Point' as const, coordinates: [DROP.lng, DROP.lat] }, phoneMasked: '+91******43210' };
    const { job, payload } = await createJob(h, { drop: { ...base, ...drop } as never });
    return { p, job, payload, token: await h.token(p.userId, ['CONSUMER', 'DELIVERY_PARTNER']) };
  }

  it('offer view + realtime partner.offer carry only area and distance from pickup (0.1 km)', async () => {
    const { p, job, token } = await offered();
    const msgs: unknown[] = [];
    const sub = await subscribeRealtime(h.ctx.redis, [`partner:${p.userId}`], (_c, m) => {
      if (m.event === 'partner.offer') msgs.push(m.data);
    });
    try {
      await runDispatchTick(h.ctx);
      await waitFor(() => msgs.length === 1, { message: 'partner.offer' });
    } finally {
      await sub.close();
    }
    const offers = await request(h.app).get('/api/v1/partner/offers').set(bearer(token));
    expect(offers.status).toBe(200);
    expect(offers.body.items).toHaveLength(1);
    const offer = offers.body.items[0];
    expect(offer.job.drop).toEqual({ area: 'HAL 2nd Stage', distanceFromPickupKm: Math.round(job.distanceKm * 10) / 10 });
    // no metre-precise pickup→drop distance or fractional minutes anywhere on the offer
    expect(offer.job.distanceKm).toBe(Math.round(job.distanceKm * 10) / 10);
    expect(Number.isInteger(offer.job.estimatedMinutes)).toBe(true);
    expect(JSON.stringify(offer)).not.toContain(String(job.distanceKm).slice(0, 6));
    expect(offer.job.pickup.name).toBe('Meghana Foods');

    for (const leak of [JSON.stringify(offer), JSON.stringify(msgs[0])]) {
      for (const s of secrets()) expect(leak, `leaked ${s}`).not.toContain(s);
    }
    expect(msgs[0]).toMatchObject({ jobId: job.id });
  });

  it('jobs created without area fall back to the pincode parsed from the address', async () => {
    const { token } = await offered({ area: undefined, label: undefined });
    await runDispatchTick(h.ctx);
    const offers = await request(h.app).get('/api/v1/partner/offers').set(bearer(token));
    expect(offers.body.items[0].job.drop.area).toBe('560038');
  });

  it('assigned partner sees name + label but no full address / coordinates until pickup', async () => {
    const { job, token } = await offered();
    await runDispatchTick(h.ctx);
    const offerId = (await h.ctx.models.Offer.findOne({ jobId: job._id }))!.id;
    const acc = await request(h.app).post(`/api/v1/deliveries/offers/${offerId}/accept`).set(bearer(token));
    expect(acc.status).toBe(200);
    const drop = acc.body.job.drop;
    expect(drop).toMatchObject({ name: CUSTOMER, area: 'HAL 2nd Stage', label: 'Home', phoneMasked: '+91******43210', address: null, location: null, addressRevealed: false });
    expect(acc.body.job.navigation.dropUrl).toBeNull();
    expect(JSON.stringify(acc.body.job)).not.toContain('12th Main');

    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    const atPickup = await request(h.app).get('/api/v1/deliveries/active').set(bearer(token));
    expect(atPickup.body.items.find((j: { id: string }) => j.id === job.id).drop.address).toBeNull();

    const picked = await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' });
    expect(picked.status).toBe(200);
    expect(picked.body.drop).toMatchObject({ address: LINE, location: DROP, label: 'Home', area: 'HAL 2nd Stage', addressRevealed: true });
    expect(picked.body.navigation.dropUrl).toContain(`${DROP.lat},${DROP.lng}`);
    const started = await request(h.app).post(`/api/v1/deliveries/${job.id}/start`).set(bearer(token));
    expect(started.body.drop).toMatchObject({ address: LINE, addressRevealed: true });

    // ruling: once finished, the job (deliver response + history) is back to area + label only
    const delivered = await request(h.app).post(`/api/v1/deliveries/${job.id}/deliver`).set(bearer(token)).send({ code: '5678' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.drop).toMatchObject({ area: 'HAL 2nd Stage', label: 'Home', address: null, location: null, addressRevealed: false });
    expect(delivered.body.navigation.dropUrl).toBeNull();
    const history = await request(h.app).get('/api/v1/deliveries/history').set(bearer(token));
    const row = history.body.items.find((j: { id: string }) => j.id === job.id);
    expect(row.drop).toMatchObject({ area: 'HAL 2nd Stage', label: 'Home', address: null, location: null, addressRevealed: false });
    expect(row.navigation.dropUrl).toBeNull();
    expect(JSON.stringify(history.body)).not.toContain('12th Main');
  });

  it('a job that failed after pickup also hides the address in history', async () => {
    const { job, token } = await offered();
    await runDispatchTick(h.ctx);
    const offerId = (await h.ctx.models.Offer.findOne({ jobId: job._id }))!.id;
    await request(h.app).post(`/api/v1/deliveries/offers/${offerId}/accept`).set(bearer(token)).expect(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/arrived`).set(bearer(token)).expect(200);
    await request(h.app).post(`/api/v1/deliveries/${job.id}/pickup`).set(bearer(token)).send({ code: '1234' }).expect(200);
    const failed = await request(h.app).post(`/api/v1/deliveries/${job.id}/fail`).set(bearer(token)).send({ reason: 'Customer not reachable' });
    expect(failed.status).toBe(200);
    expect(failed.body.drop).toMatchObject({ address: null, location: null, addressRevealed: false });
    const history = await request(h.app).get('/api/v1/deliveries/history').set(bearer(token));
    expect(JSON.stringify(history.body)).not.toContain('12th Main');
  });

  it('admin job view keeps the full drop plus area + label', async () => {
    const { job } = await offered();
    const res = await request(h.app).get('/api/v1/admin/delivery/jobs').set(bearer(await h.adminToken()));
    const row = res.body.items.find((j: { id: string }) => j.id === job.id);
    expect(row.drop).toMatchObject({ name: CUSTOMER, address: LINE, area: 'HAL 2nd Stage', label: 'Home' });
  });
});
