/**
 * Seed the demo data into every service's own database (`npm run seed`).
 *
 *   npm run seed                         # inside the running docker stack (docker compose exec <svc> node dist/seed.js)
 *   npm run seed -- identity marketplace # only these services
 *   npm run seed -- --local              # host mode: tsx services/<svc>/src/seed.ts with the env from .env
 *                                        #   (infra stack: one unauthenticated Mongo, so per-service DB isolation is by name only)
 *   npm run seed -- --no-images          # skip the photo mirror (scripts/seed-images.ts); seeds use the last manifest
 *   npm run seed -- --no-blr             # only the small named demo story (SEED_BLR=0), no Bengaluru dataset
 *
 * Each service seed is idempotent (deterministic seedId() ids; existing documents are never overwritten)
 * and refuses to run unless APP_MODE=demo. A second run reports 0 inserts. Services run in dependency
 * order of the demo story; a service without a seed script is skipped with a notice.
 *
 * Bengaluru dataset (`@thali/contracts/seed-blr`): first the photo mirror fills MinIO and writes
 * `.cache/seed-images/manifest.json`; then every service regenerates the same deterministic world and writes its
 * slice. One anchor instant (SEED_BLR_ANCHOR, now) is passed to all services so their timestamps line up. In
 * docker mode `scripts/seed-data` and the manifest are copied into each container (`/tmp/thali-seed`) and
 * passed as SEED_DATA_DIR / SEED_IMAGE_MANIFEST (the images do not ship the data).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, mirrorSeedImages } from './seed-images.js';

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
  ms?: number;
}
const CONTAINER_DIR = '/tmp/thali-seed';

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

/** Copy the seed data + image manifest into the container (the images do not ship them). */
async function shipSeedData(service: Service): Promise<string | null> {
  const prep = await run('docker', ['compose', 'exec', '-T', '-u', 'root', service, 'sh', '-c', `rm -rf ${CONTAINER_DIR} && mkdir -p ${CONTAINER_DIR}`]);
  if (prep.code !== 0) return 'could not prepare /tmp/thali-seed in the container';
  if ((await run('docker', ['compose', 'cp', resolve(ROOT, 'scripts/seed-data'), `${service}:${CONTAINER_DIR}/data`])).code !== 0) return 'docker compose cp of scripts/seed-data failed';
  if (existsSync(MANIFEST_PATH) && (await run('docker', ['compose', 'cp', MANIFEST_PATH, `${service}:${CONTAINER_DIR}/manifest.json`])).code !== 0) return 'docker compose cp of the image manifest failed';
  await run('docker', ['compose', 'exec', '-T', '-u', 'root', service, 'chmod', '-R', 'a+rX', CONTAINER_DIR]);
  return null;
}

async function seedOne(service: Service, local: boolean, dotenv: Record<string, string>, seedEnv: Record<string, string>): Promise<Result> {
  // `skipped` only for a service that has no seed at all; anything that should seed but cannot is `failed`.
  if (!existsSync(resolve(ROOT, `services/${service}/src/seed.ts`))) return { service, status: 'skipped', note: 'service has no seed script' };
  process.stdout.write(`\n=== seed ${service} ${local ? '(local)' : '(docker compose exec)'}\n`);
  const t0 = Date.now();
  let res: { code: number; out: string };
  if (local) {
    const env = { ...process.env, ...dotenv, ...seedEnv, SERVICE_NAME: service, PORT: PORTS[service] };
    res = await run('npx', ['tsx', `services/${service}/src/seed.ts`], env);
  } else {
    const probe = await run('docker', ['compose', 'exec', '-T', service, 'test', '-f', 'dist/seed.js']);
    if (probe.code !== 0) return { service, status: 'failed', note: 'container not running or image has no dist/seed.js (start/rebuild: npm run stack:up)' };
    const envArgs = Object.entries(seedEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    if (seedEnv.SEED_BLR !== '0') {
      const err = await shipSeedData(service);
      if (err) return { service, status: 'failed', note: err };
      envArgs.push('-e', `SEED_DATA_DIR=${CONTAINER_DIR}/data`, '-e', `SEED_IMAGE_MANIFEST=${CONTAINER_DIR}/manifest.json`);
    }
    res = await run('docker', ['compose', 'exec', '-T', ...envArgs, service, 'node', 'dist/seed.js']);
  }
  const parsed = parseResult(res.out);
  if (res.code !== 0 || !parsed) return { service, status: 'failed', note: `exit ${res.code}`, ms: Date.now() - t0 };
  return { service, status: 'ok', ...parsed, ms: Date.now() - t0 };
}

async function main() {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const wanted = args.filter((a) => !a.startsWith('--'));
  for (const w of wanted) if (!(ORDER as readonly string[]).includes(w)) throw new Error(`unknown service "${w}" (known: ${ORDER.join(', ')})`);
  const services = ORDER.filter((s) => !wanted.length || wanted.includes(s));
  const dotenv = local ? readDotEnv(resolve(ROOT, '.env')) : {};
  if (local && (dotenv.APP_MODE ?? process.env.APP_MODE) !== 'demo') throw new Error('Refusing to seed: APP_MODE must be demo');
  const tStart = Date.now();
  const blr = !args.includes('--no-blr') && process.env.SEED_BLR !== '0';
  // one anchor for every service so the generated timestamps line up (whole minutes)
  const seedEnv: Record<string, string> = {
    SEED_BLR_ANCHOR: process.env.SEED_BLR_ANCHOR ?? new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
    SEED_BLR: blr ? '1' : '0',
  };
  if (blr && !args.includes('--no-images')) {
    process.stdout.write('\n=== seed images (photo mirror into MinIO)\n');
    const t = Date.now();
    await mirrorSeedImages().catch((e: unknown) => process.stdout.write(`  image mirror failed (${(e as Error).message}); photos stay absolute URLs\n`));
    process.stdout.write(`  (${((Date.now() - t) / 1000).toFixed(1)} s)\n`);
  }

  const results: Result[] = [];
  for (const s of services) {
    const r = await seedOne(s, local, dotenv, seedEnv);
    results.push(r);
    if (r.status === 'failed') break; // later services reference earlier ones
  }

  process.stdout.write(`\n=== seed summary (anchor ${seedEnv.SEED_BLR_ANCHOR}${blr ? '' : ', Bengaluru dataset skipped'})\n`);
  for (const r of results) {
    const counts = r.status === 'ok' ? `inserted ${String(r.inserted).padStart(6)}   existing ${String(r.existing).padStart(6)}` : '';
    const ms = r.ms !== undefined ? `  ${(r.ms / 1000).toFixed(1).padStart(5)} s` : '';
    process.stdout.write(`  ${r.service.padEnd(14)} ${r.status.toUpperCase().padEnd(8)} ${counts}${ms}${r.note ? `  (${r.note})` : ''}\n`);
  }
  const total = results.reduce((n, r) => n + (r.inserted ?? 0), 0);
  const failed = results.some((r) => r.status === 'failed');
  const notRun = services.length - results.length; // stopped after a failure
  const allOk = results.length === services.length && results.every((r) => r.status === 'ok');
  process.stdout.write(`  total inserted: ${total}${allOk && total === 0 ? ' (already seeded: nothing changed)' : ''}   total time ${((Date.now() - tStart) / 1000).toFixed(1)} s\n`);
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
