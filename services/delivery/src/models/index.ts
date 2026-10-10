import type { Connection } from 'mongoose';
import { cancelledOrderModel, type CancelledOrderModel } from './cancelled-order.js';
import { jobModel, type JobModel } from './delivery-job.js';
import { offerModel, type OfferModel } from './delivery-offer.js';
import { locationPingModel, type LocationPingModel } from './location-ping.js';
import { partnerModel, type PartnerModel } from './partner.js';

export interface DeliveryModels {
  Partner: PartnerModel;
  Job: JobModel;
  Offer: OfferModel;
  LocationPing: LocationPingModel;
  CancelledOrder: CancelledOrderModel;
}

export function getModels(conn: Connection): DeliveryModels {
  return {
    Partner: partnerModel(conn),
    Job: jobModel(conn),
    Offer: offerModel(conn),
    LocationPing: locationPingModel(conn),
    CancelledOrder: cancelledOrderModel(conn),
  };
}

/**
 * Create collections + indexes before serving: transactions must not race implicit collection
 * creation, and the unique indexes (userId, childOrderId, jobId+partnerId+round) are correctness guards.
 */
export async function initDeliveryModels(conn: Connection): Promise<DeliveryModels> {
  const models = getModels(conn);
  for (const m of Object.values(models)) {
    await m.createCollection().catch((err: { codeName?: string }) => {
      if (err?.codeName !== 'NamespaceExists') throw err;
    });
    await m.init();
  }
  return models;
}
