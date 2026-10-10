/** Pricing types (LLD §2.2). Self-contained: this package is pure and has no runtime deps. */

export interface PricingConfig {
  foodTaxBps: number;
  feeTaxBps: number;
  platformFeePaise: number;
}

export interface AddOnInput {
  id: string;
  name: string;
  pricePaise: number;
}

export interface LineInput {
  itemId: string;
  name: string;
  unitPricePaise: number;
  addOns: AddOnInput[];
  quantity: number;
}

export interface RestaurantInput {
  restaurantId: string;
  lines: LineInput[];
  packagingFeePaise: number;
  /** Already computed from the service-area rule + distance (see computeDeliveryFee). */
  deliveryFeePaise: number;
}

export interface GroupDiscountInput {
  couponCode?: string;
  /** Computed by marketplace; must be <= sum of all itemsSubtotal. */
  couponDiscountPaise: number;
}

export interface MembershipBenefitInput {
  freeDeliveryRestaurantIds: string[];
  extraDiscountBps: number;
  extraDiscountCapPaise: number;
}

export interface Breakdown {
  itemsSubtotalPaise: number;
  couponDiscountPaise: number;
  membershipDiscountPaise: number;
  packagingFeePaise: number;
  deliveryFeePaise: number;
  deliveryDiscountPaise: number;
  platformFeePaise: number;
  foodTaxPaise: number;
  feeTaxPaise: number;
  totalPaise: number;
}

export type PricedLine = LineInput & { lineTotalPaise: number };

export interface PricedChild {
  restaurantId: string;
  lines: PricedLine[];
  breakdown: Breakdown;
}

export interface PricedCheckout {
  children: PricedChild[];
  totals: Breakdown;
}

export interface DeliveryFeeRule {
  basePaise: number;
  baseKm: number;
  perKmPaise: number;
  maxPaise: number;
}
