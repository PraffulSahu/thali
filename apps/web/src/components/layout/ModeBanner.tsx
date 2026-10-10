/**
 * Environment banners from `GET /meta` (design-spec §3.12). Hidden in production, while loading, and if
 * /meta fails (never guess the mode). Not dismissible.
 *
 *   <ModeBanner />   // app strip: 32px, ink background, mono turmeric text (sandbox: sky text)
 *   <DemoPill />     // public utility-bar pill: "DEMO MODE · no real money, SMS or deliveries"
 */
import { useMeta } from '../../hooks/useMeta';
import { cn } from '../../lib/cn';

function providersTitle(providers: Record<string, string> | undefined): string | undefined {
  if (!providers) return undefined;
  const list = Object.entries(providers).map(([k, v]) => `${k}: ${v}`);
  return list.length ? `Providers — ${list.join(', ')}` : undefined;
}

export function ModeBanner({ className }: { className?: string }) {
  const { mode, meta } = useMeta();
  if (mode !== 'demo' && mode !== 'sandbox') return null;
  const demo = mode === 'demo';
  return (
    <div
      role="status"
      aria-label={demo ? 'Demo mode' : 'Sandbox mode'}
      title={providersTitle(meta?.providers as Record<string, string> | undefined)}
      className={cn(
        'on-color flex min-h-8 items-center justify-center bg-strip px-4 py-1.5 text-center font-mono text-xs font-medium leading-tight tracking-[.04em]',
        demo ? 'text-strip-fg' : 'text-[#7aa7ff]',
        className,
      )}
    >
      {demo ? 'DEMO MODE — no real money, SMS or deliveries' : 'SANDBOX — real providers in test mode, no real charges'}
    </div>
  );
}

/** Same as ModeBanner (alias with the design-system name). */
export const DemoBanner = ModeBanner;

export function DemoPill({ className }: { className?: string }) {
  const { mode, meta } = useMeta();
  if (mode !== 'demo' && mode !== 'sandbox') return null;
  const demo = mode === 'demo';
  return (
    <span
      role="status"
      title={providersTitle(meta?.providers as Record<string, string> | undefined)}
      className={cn(
        'inline-flex h-6 items-center gap-[7px] rounded-xs px-[9px] font-mono text-[11px] font-semibold tracking-[.03em]',
        demo ? 'bg-sun-soft text-sun-ink' : 'bg-info-bg text-info',
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {demo ? 'DEMO MODE · no real money, SMS or deliveries' : 'SANDBOX · test mode, no real charges'}
    </span>
  );
}
