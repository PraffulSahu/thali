/** Hand a `tel:` URL to the device dialer (separate module so tests can observe it without navigating jsdom). */
export function openDialer(telUrl: string): void {
  window.location.href = telUrl;
}
