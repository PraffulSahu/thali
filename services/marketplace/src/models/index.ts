/**
 * Model registry. Task 9 adds its models (stock_reservations, coupons, ...) by extending `getModels`
 * and `ensureMarketplaceIndexes` — each model file exports `xxxModel(conn)`.
 */
import type { Connection } from 'mongoose';
import { initEventCollections } from '@thali/service-kit';
import { bannerModel } from './banner.js';
import { cuisineModel } from './cuisine.js';
import { menuCategoryModel } from './menu-category.js';
import { menuItemModel } from './menu-item.js';
import { restaurantModel } from './restaurant.js';
import { serviceAreaModel } from './service-area.js';
import { stockReservationModel } from './stock-reservation.js';
import { couponModel } from './coupon.js';
import { couponRedemptionModel } from './coupon-redemption.js';
import { membershipPlanModel } from './membership-plan.js';
import { membershipModel } from './membership.js';
import { ratingModel } from './rating.js';
import { localityModel } from './locality.js';

export function getModels(conn: Connection) {
  return {
    Restaurant: restaurantModel(conn),
    MenuCategory: menuCategoryModel(conn),
    MenuItem: menuItemModel(conn),
    ServiceArea: serviceAreaModel(conn),
    Cuisine: cuisineModel(conn),
    Banner: bannerModel(conn),
    // Task 9 (commerce)
    StockReservation: stockReservationModel(conn),
    Coupon: couponModel(conn),
    CouponRedemption: couponRedemptionModel(conn),
    MembershipPlan: membershipPlanModel(conn),
    Membership: membershipModel(conn),
    Rating: ratingModel(conn),
    // UI redesign (MKT-1)
    Locality: localityModel(conn),
  };
}
export type Models = ReturnType<typeof getModels>;

/**
 * Create collections + indexes before serving (collection creation must not race the first
 * transaction; 2dsphere indexes are required for `$geoIntersects`/`$geoWithin`).
 */
export async function ensureMarketplaceIndexes(conn: Connection): Promise<void> {
  await initEventCollections(conn);
  for (const model of Object.values(getModels(conn))) {
    await model.createCollection().catch((e: { codeName?: string }) => {
      if (e?.codeName !== 'NamespaceExists') throw e;
    });
    await model.syncIndexes();
  }
}
