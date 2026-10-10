import { z } from 'zod';
import { CheckoutStatus, ChildOrderStatus, enumValues } from '../enums.js';
import { AddressSchema } from './address.js';
import { PaiseSchema } from './common.js';

/** Price breakdown (LLD 2.2). Σ child.breakdown.X == totals.X for every X. */
export const BreakdownSchema = z.object({
  itemsSubtotalPaise: PaiseSchema,
  couponDiscountPaise: PaiseSchema,
  membershipDiscountPaise: PaiseSchema,
  packagingFeePaise: PaiseSchema,
  deliveryFeePaise: PaiseSchema,
  deliveryDiscountPaise: PaiseSchema,
  platformFeePaise: PaiseSchema,
  foodTaxPaise: PaiseSchema,
  feeTaxPaise: PaiseSchema,
  totalPaise: PaiseSchema,
});
export type Breakdown = z.infer<typeof BreakdownSchema>;

export const ChildOrderStatusSchema = z.enum(enumValues(ChildOrderStatus));
export const CheckoutStatusSchema = z.enum(enumValues(CheckoutStatus));

/** `POST /checkouts` body (LLD 8). Exactly one of `addressId` / `address`. */
export const CreateCheckoutBodySchema = z
  .object({
    addressId: z.string().optional(),
    address: AddressSchema.optional(),
    couponCode: z.string().trim().min(1).max(40).optional(),
    useMembership: z.boolean().default(false),
    expectedTotalPaise: PaiseSchema.optional(),
  })
  .refine((v) => (v.addressId === undefined) !== (v.address === undefined), {
    message: 'Provide exactly one of addressId or address',
    path: ['addressId'],
  });
export type CreateCheckoutBody = z.infer<typeof CreateCheckoutBodySchema>;

/** Restaurant accept: prepMinutes 5-120. */
export const AcceptOrderBodySchema = z.object({ prepMinutes: z.number().int().min(5).max(120) });
/** Reject / admin cancel: reason required. */
export const ReasonBodySchema = z.object({ reason: z.string().trim().min(1).max(500) });
