/**
 * Seed the demo data into every service's own database (`npm run seed`).
 *
 *   npm run seed                         # inside the running docker stack (docker compose exec <svc> node dist/seed.js)
 *   npm run seed -- identity marketplace # only these services
 *   npm run seed -- --local              # host mode: tsx services/<svc>/src/seed.ts with the env from .env
 *                                        #   (infra stack: one unauthenticated Mongo, so per-service DB isolation is by name only)
 *
 * Each service seed is idempotent (deterministic seedId() ids; existing documents are never overwritten)
 * and refuses to run unless APP_MODE=demo. A second run reports 0 inserts. Services run in dependency
 * order of the demo story; a service without a seed script is skipped with a notice.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The gateway owns no database and has no seed: it is deliberately not in this list (its package.json `seed`
// script points at a file that does not exist; never call it).
const ORDER = ['identity', 'marketplace', 'delivery', 'payments', 'notifications', 'orders'] as const;
type Service = (typeof ORDER)[number];
const PORTS: Record<Service, string> = { identity: '4001', marketplace: '4002', orders: '4003', payments: '4004', delivery: '4005', notifications: '4006' };

interface Result {
  service: Service;
  status: 'ok' | 'skipped' | 'failed';
  inserted?: number;
  existing?: number;
  note?: string;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      process.stdout.write(b);
    });
    child.stderr.on('data', (b: Buffer) => process.stderr.write(b));
    child.on('error', (e) => {
      process.stderr.write(`${cmd}: ${e.message}\n`);
      done({ code: 127, out });
    });
    child.on('close', (code) => done({ code: code ?? 1, out }));
  });
}

/** Minimal .env reader for --local (KEY=VALUE, optional quotes, `#` comments). */
function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]!] = v;
  }
  return env;
}

function parseResult(out: string): { inserted: number; existing: number } | null {
  const line = out.split('\n').reverse().find((l) => l.startsWith('SEED_RESULT '));
  if (!line) return null;
  const r = JSON.parse(line.slice('SEED_RESULT '.length)) as { inserted: number; report: Record<string, { existing: number }> };
  return { inserted: r.inserted, existing: Object.values(r.report).reduce((n, t) => n + t.existing, 0) };
}

async function seedOne(service: Service, local: boolean, dotenv: Record<string, string>): Promise<Result> {
  // `skipped` only for a service that has no seed at all; anything that should seed but cannot is `failed`.
  if (!existsSync(resolve(ROOT, `services/${service}/src/seed.ts`))) return { service, status: 'skipped', note: 'service has no seed script' };
  process.stdout.write(`\n=== seed ${service} ${local ? '(local)' : '(docker compose exec)'}\n`);
  let res: { code: number; out: string };
  if (local) {
    const env = { ...process.env, ...dotenv, SERVICE_NAME: service, PORT: PORTS[service] };
    res = await run('npx', ['tsx', `services/${service}/src/seed.ts`], env);
  } else {
    const probe = await run('docker', ['compose', 'exec', '-T', service, 'test', '-f', 'dist/seed.js']);
    if (probe.code !== 0) return { service, status: 'failed', note: 'container not running or image has no dist/seed.js (start/rebuild: npm run stack:up)' };
    res = await run('docker', ['compose', 'exec', '-T', service, 'node', 'dist/seed.js']);
  }
  const parsed = parseResult(res.out);
  if (res.code !== 0 || !parsed) return { service, status: 'failed', note: `exit ${res.code}` };
  return { service, status: 'ok', ...parsed };
}

async function main() {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const wanted = args.filter((a) => !a.startsWith('--'));
  for (const w of wanted) if (!(ORDER as readonly string[]).includes(w)) throw new Error(`unknown service "${w}" (known: ${ORDER.join(', ')})`);
  const services = ORDER.filter((s) => !wanted.length || wanted.includes(s));
  const dotenv = local ? readDotEnv(resolve(ROOT, '.env')) : {};
  if (local && (dotenv.APP_MODE ?? process.env.APP_MODE) !== 'demo') throw new Error('Refusing to seed: APP_MODE must be demo');

  const results: Result[] = [];
  for (const s of services) {
    const r = await seedOne(s, local, dotenv);
    results.push(r);
    if (r.status === 'failed') break; // later services reference earlier ones
  }

  process.stdout.write('\n=== seed summary\n');
  for (const r of results) {
    const counts = r.status === 'ok' ? `inserted ${String(r.inserted).padStart(4)}   existing ${String(r.existing).padStart(4)}` : '';
    process.stdout.write(`  ${r.service.padEnd(14)} ${r.status.toUpperCase().padEnd(8)} ${counts}${r.note ? `  (${r.note})` : ''}\n`);
  }
  const total = results.reduce((n, r) => n + (r.inserted ?? 0), 0);
  const failed = results.some((r) => r.status === 'failed');
  const notRun = services.length - results.length; // stopped after a failure
  const allOk = results.length === services.length && results.every((r) => r.status === 'ok');
  process.stdout.write(`  total inserted: ${total}${allOk && total === 0 ? ' (already seeded: nothing changed)' : ''}\n`);
  if (notRun) process.stdout.write(`  not run: ${notRun} service(s) after the failure\n`);
  if (failed) {
    process.stdout.write('  SEED FAILED\n');
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`seed: ${(e as Error).message}\n`);
  process.exit(1);
});
