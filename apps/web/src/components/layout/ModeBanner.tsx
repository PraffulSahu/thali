/**
 * Persistent environment banner from `GET /meta` (PRD §6): "DEMO MODE" or "SANDBOX". Hidden in production,
 * while loading, and if /meta fails (never guess the mode). Not dismissible by design.
 */
import { useMeta } from '../../hooks/useMeta';

export function ModeBanner() {
  const { mode, meta } = useMeta();
  if (mode !== 'demo' && mode !== 'sandbox') return null;
  const demo = mode === 'demo';
  const mocked = meta?.providers
    ? Object.entries(meta.providers)
        .filter(([, v]) => v === 'demo')
        .map(([k]) => k)
    : [];
  return (
    <div
      role="note"
      aria-label={demo ? 'Demo mode' : 'Sandbox mode'}
      className={demo ? 'bg-slate-900 text-slate-100' : 'bg-info-800 text-white'}
    >
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-4 py-1.5 text-center text-xs sm:text-[0.8125rem]">
        <span className="inline-flex items-center gap-1.5 font-bold tracking-wider">
          <span aria-hidden="true" className={demo ? 'size-2 rounded-full bg-warn-600' : 'size-2 rounded-full bg-info-100'} />
          {demo ? 'DEMO MODE' : 'SANDBOX'}
        </span>
        <span className={demo ? 'text-slate-300' : 'text-info-100'}>
          {demo
            ? `Seeded data and simulated providers${mocked.length ? ` (${mocked.join(', ')})` : ''}. No real money moves.`
            : 'Real providers in test mode. No real charges.'}
        </span>
      </div>
    </div>
  );
}
