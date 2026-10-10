/** Demo GeoProvider: haversine × ROAD_FACTOR (1.3) ÷ AVG_SPEED_KMPH (20), labelled `DEMO_HAVERSINE`. */
import { roadEstimate, type GeoProvider, type RoadEstimateOptions } from './geo.js';

export function createDemoGeo(opts: RoadEstimateOptions = {}): GeoProvider {
  return {
    name: 'demo',
    async distanceAndEta(from, to) {
      return { ...roadEstimate(from, to, opts), source: 'DEMO_HAVERSINE' };
    },
  };
}
