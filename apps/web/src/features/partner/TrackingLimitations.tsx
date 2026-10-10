/**
 * Browser-limits tip (board 30, row 30-31) with the full plain-language explanation one tap away. This is a web
 * app: it cannot track in the background, and we never pretend otherwise (or fake movement while paused).
 */
import { Icon } from '../../components/ui/Icon';

export function TrackingLimitations() {
  return (
    <aside aria-label="How location sharing works in a browser" className="rounded-field border border-line bg-warn-bg px-4 py-3.5 text-[13px] leading-normal text-fg-2">
      <div className="flex gap-2.5">
        <Icon name="info" size={16} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p>Keep Thali open while delivering. Your browser pauses location when this tab is in the background or the screen locks.</p>
          <details className="group mt-2">
            <summary className="cursor-pointer list-none font-semibold text-fg underline underline-offset-2 [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Why, and what else stops it?</span>
              <span className="hidden group-open:inline">Hide details</span>
            </summary>
            <ul className="mt-2 list-disc space-y-1.5 pl-4">
              <li>While location is paused the customer sees your last known position, marked as stale.</li>
              <li>Sharing resumes by itself when you come back to this tab.</li>
              <li>Opening Google Maps switches away from this tab, so sharing pauses until you return. Use split-screen if your phone supports it.</li>
              <li>Battery saver, data saver and “block location” settings can also stop updates. Allow location for this site in your browser settings.</li>
              <li>Thali only sends real positions from your device, at most once every 5 seconds, and stops completely when you go offline.</li>
            </ul>
          </details>
        </div>
      </div>
    </aside>
  );
}
