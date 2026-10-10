/**
 * Docker-stack helpers: `docker compose` calls (run from the repo root), Redis rate-limit reset for the demo
 * phones, internal route/OpenAPI introspection inside the compose network, and the Mailpit API.
 */
import { execFileSync } from 'node:child_process';
import { MAILPIT_URL, REPO_ROOT, sleep } from './env.js';

export function compose(args: string[], opts: { input?: string; timeoutMs?: number } = {}): string {
  return execFileSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeoutMs ?? 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Clear the OTP / admin-login rate-limit counters in the demo Redis.
 *
 * The suite signs in ~20 times per run (UI + API) from one IP, while identity allows 20 OTP requests per IP per
 * hour, 5 per phone per hour and a 30 s resend cooldown. Re-running the suite (or running it next to
 * `npm run smoke`) would otherwise lock every demo phone for an hour. Rate limiting itself is covered by the
 * identity/gateway unit + integration tests, not by these flows. Disable with E2E_RESET_RATE_LIMITS=0.
 */
export function resetAuthRateLimits(): void {
  if (process.env.E2E_RESET_RATE_LIMITS === '0') return;
  compose(
    ['exec', '-T', 'redis', 'sh', '-c', "for p in '*rl:*otp*' '*rl:admin-*'; do redis-cli --scan --pattern \"$p\" | xargs -r redis-cli DEL >/dev/null; done"],
    { timeoutMs: 20_000 },
  );
}

export interface RouteInfo {
  method: string;
  path: string;
}
export interface ServiceIntrospection {
  routes: RouteInfo[];
  /** The service's own /openapi.json (includes /internal/* and /health/*). */
  spec: { paths: Record<string, Record<string, unknown>> };
}

/**
 * Inside the service container (compose network): mint a 60 s service token with service-kit
 * `signServiceToken('gateway' -> <svc>)` and INTERNAL_SERVICE_SECRET from the container env, then call
 * `GET /internal/routes` and `GET /openapi.json` on the service's own port.
 */
export function introspectService(service: string): ServiceIntrospection {
  const script = `
    const { signServiceToken } = await import('@thali/service-kit');
    const self = process.env.SERVICE_NAME;
    const caller = self === 'gateway' ? 'identity' : 'gateway';
    const token = await signServiceToken(caller, self, process.env.INTERNAL_SERVICE_SECRET);
    const base = 'http://127.0.0.1:' + process.env.PORT;
    const r = await fetch(base + '/internal/routes', { headers: { authorization: 'Bearer ' + token } });
    if (r.status !== 200) throw new Error('GET /internal/routes -> ' + r.status + ' ' + (await r.text()));
    const s = await fetch(base + '/openapi.json');
    process.stdout.write(JSON.stringify({ routes: await r.json(), spec: await s.json() }));
  `;
  const out = compose(['exec', '-T', service, 'node', '--input-type=module', '-e', script], { timeoutMs: 60_000 });
  return JSON.parse(out) as ServiceIntrospection;
}

export interface ComposeContainer {
  Service: string;
  Name: string;
  State: string;
  Health: string;
  ExitCode: number;
  Status: string;
}

/** `docker compose ps -a --format json` (NDJSON or a JSON array depending on the compose version). */
export function composePs(): ComposeContainer[] {
  const out = compose(['ps', '-a', '--format', 'json']).trim();
  if (!out) return [];
  if (out.startsWith('[')) return JSON.parse(out) as ComposeContainer[];
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ComposeContainer);
}

/* ------------------------------------------------------------------ Mailpit */

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
  To: { Address: string }[];
}

/** Latest message to `to` created after `since` (polls until `timeoutMs`). */
export async function waitForEmail(to: string, opts: { since: Date; timeoutMs?: number; subject?: RegExp }): Promise<{ id: string; subject: string; text: string; html: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`);
    if (r.ok) {
      const body = (await r.json()) as { messages?: MailpitSummary[] };
      const hit = (body.messages ?? []).find(
        (m) => new Date(m.Created).getTime() >= opts.since.getTime() - 2000 && (!opts.subject || opts.subject.test(m.Subject)),
      );
      if (hit) {
        const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`)).json()) as { Subject: string; Text: string; HTML: string };
        return { id: hit.ID, subject: full.Subject, text: full.Text ?? '', html: full.HTML ?? '' };
      }
    }
    if (Date.now() > deadline) throw new Error(`no email to ${to} in Mailpit (${MAILPIT_URL}) within ${opts.timeoutMs ?? 60_000} ms`);
    await sleep(1500);
  }
}
