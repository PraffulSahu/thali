/**
 * The consumer's chosen delivery location. Single source of truth = the foundation store in `lib/location`
 * (localStorage `thali.location`, `{lat,lng,label,source,addressId?,address?,placeId?}`), shared with the public
 * landing and the `/` gate. Kept as a module so consumer code and tests keep their import path.
 */
export {
  LOCATION_STORAGE_KEY,
  getChosenLocation as getLocation,
  setChosenLocation as setLocation,
  useChosenLocation,
  type ChosenLocation,
} from '../../lib/location';
