/** The restaurant the owner is currently working on (set by RestaurantLayout, consumed by every page). */
import { createContext, useContext } from 'react';
import type { OwnerRestaurant } from './api';

export interface RestaurantContextValue {
  restaurant: OwnerRestaurant;
}

export const RestaurantContext = createContext<RestaurantContextValue | null>(null);

export function useCurrentRestaurant(): OwnerRestaurant {
  const ctx = useContext(RestaurantContext);
  if (!ctx) throw new Error('useCurrentRestaurant must be used inside RestaurantLayout');
  return ctx.restaurant;
}
