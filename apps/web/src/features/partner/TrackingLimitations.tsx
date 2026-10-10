/**
 * Plain-language panel on browser background-tracking limits. This is a web app: it cannot track in the
 * background, and we do not pretend otherwise (and never fake movement while paused).
 */
import { Card, CardHeader } from '../../components/ui/Card';
import { Icon } from '../../components/ui/Icon';

export function TrackingLimitations() {
  return (
    <Card tone="muted" aria-labelledby="tracking-limits-heading">
      <CardHeader title={<span id="tracking-limits-heading">How location sharing works in a browser</span>} as="h2" />
      <ul className="mt-2 space-y-2 text-sm text-slate-700">
        <li className="flex gap-2">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warn-600" />
          <span>
            <strong>Browsers pause geolocation when this tab is in the background or the screen is locked.</strong> While that
            happens your location is not updated, and the customer sees their last known position marked as stale.
          </span>
        </li>
        <li className="flex gap-2">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-info-600" />
          <span>Keep Thali open in the foreground with the screen on while you are online or on a delivery. Sharing resumes by itself when you come back to this tab.</span>
        </li>
        <li className="flex gap-2">
          <Icon name="map" size={16} className="mt-0.5 shrink-0 text-info-600" />
          <span>Opening Google Maps for navigation switches away from this tab, so sharing pauses until you return. Use split-screen if your phone supports it.</span>
        </li>
        <li className="flex gap-2">
          <Icon name="bell" size={16} className="mt-0.5 shrink-0 text-info-600" />
          <span>Battery saver, data saver and "block location" settings can also stop updates. Allow location for this site in your browser settings.</span>
        </li>
        <li className="flex gap-2">
          <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-info-600" />
          <span>We only send real positions from your device, at most once every 5 seconds, and stop completely when you go offline or close the app.</span>
        </li>
      </ul>
    </Card>
  );
}
