/**
 * Mirror the Bengaluru seed photos into the local MinIO public bucket (`npm run seed:images`; `npm run seed`
 * runs it first unless `--no-images`).
 *
 *   npm run seed:images                       # download (cached) + upload + write the manifest
 *   npm run seed:images -- --no-upload        # only fill the download cache
 *   npm run seed:images -- --offline          # no downloads: upload whatever is cached
 *   npm run seed:images -- --concurrency 4
 *
 * Every image in `scripts/seed-data/images.json` (the ~640-960 px `url`, falling back to `thumbUrl`) and every
 * avatar in `avatars.json` is downloaded once into `.cache/seed-images/` (gitignored), with at most 6 requests
 * in flight, a polite User-Agent and retries with exponential backoff on 429 / 5xx (all workers pause while
 * a host is throttling us). Files that still fail are skipped. Each cached file is then uploaded to the public
 * bucket (HEAD first, PUT only when missing, so re-runs upload nothing):
 *   images/pool/<imageId>.jpg          dish, cuisine, cover and hero photos
 *   images/avatars/<gender>-<n>.jpg    profile pictures
 * `.cache/seed-images/manifest.json` lists exactly the ids that are present in the bucket. The marketplace and
 * identity seeds reference those keys and fall back to the absolute (EXTERNAL_IMAGE_HOSTS-allowlisted) URL for
 * the rest, so after one successful mirror the app shows every photo without internet access.
 * Never fails the seed: an unreachable MinIO just yields an empty manifest (every photo stays an absolute URL).
 * Refuses unless APP_MODE=demo (`.env` merged under the environment), like every seed.
 *
 * Env (else `.env`): MINIO_ROOT_USER / MINIO_ROOT_PASSWORD, MINIO_HOST_PORT (9000), S3_PUBLIC_BUCKET (thali-public),
 * SEED_IMAGES_S3_ENDPOINT (default http://localhost:<MINIO_HOST_PORT>).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ROOT, assertDemoMode, mergedEnv } from './lib/dotenv.js';
const DATA = resolve(ROOT, 'scripts/seed-data');
const CACHE = resolve(ROOT, '.cache/seed-images');
export const MANIFEST_PATH = resolve(CACHE, 'manifest.json');
const USER_AGENT = 'ThaliSeedMirror/1.0 (local demo seed for a food-delivery app; contact: dev@thali.demo)';

interface ImageRow { id: string; kind: string; url: string; thumbUrl?: string }
interface AvatarRow { id: string; gender: 'male' | 'female'; url: string; thumbUrl?: string }
interface Job { id: string; group: 'pool' | 'avatars'; file: string; key: string; urls: string[] }
export interface ImageManifest { version: 1; bucket: string; generatedAt: string; pool: Record<string, string>; avatars: Record<string, string>; failed: string[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `avatar-male-07` → `images/avatars/male-7.jpg`. */
export function avatarKeyOf(id: string, gender: string): string {
  const n = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return `images/avatars/${gender}-${n}.jpg`;
}
export const poolKeyOf = (id: string) => `images/pool/${id}.jpg`;

function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

// ------------------------------------------------------------------------------------- downloads --
/** Per-host pause after a 429 (shared by all workers so we back off together). */
const hostPausedUntil = new Map<string, number>();

async function fetchOnce(url: string): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; retryAfterMs?: number }> {
  const host = new URL(url).host;
  const wait = (hostPausedUntil.get(host) ?? 0) - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const r = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'image/*' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      const ra = Number(r.headers.get('retry-after'));
      await r.body?.cancel();
      return { ok: false, status: r.status, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) };
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (!sniff(body)) return { ok: false, status: 415 };
    return { ok: true, body };
  } catch {
    return { ok: false, status: 0 }; // network error / timeout
  }
}

async function download(job: Job, log: (s: string) => void): Promise<boolean> {
  for (const url of job.urls) {
    let delay = 2000;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = await fetchOnce(url);
      if (r.ok) {
        mkdirSync(dirname(job.file), { recursive: true });
        writeFileSync(`${job.file}.part`, r.body);
        renameSync(`${job.file}.part`, job.file);
        return true;
      }
      const retryable = r.status === 0 || r.status === 429 || r.status >= 500;
      if (!retryable) break; // 404 / 403 / not an image: try the next url
      const pause = Math.min(60_000, r.retryAfterMs ?? delay);
      if (r.status === 429) hostPausedUntil.set(new URL(url).host, Date.now() + pause);
      if (attempt < 5) await sleep(pause);
      delay *= 2;
    }
    if (url !== job.urls[job.urls.length - 1]) log(`  ${job.id}: falling back to thumbUrl\n`);
  }
  return false;
}

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    }),
  );
}

// --------------------------------------------------------------------------------------------- main --
export async function mirrorSeedImages(opts: { upload?: boolean; offline?: boolean; concurrency?: number; log?: (s: string) => void } = {}): Promise<ImageManifest> {
  const log = opts.log ?? ((s: string) => process.stdout.write(s));
  const concurrency = Math.max(1, Math.min(6, opts.concurrency ?? 6));
  const env = mergedEnv();
  assertDemoMode(env, 'mirror demo photos'); // writes the public bucket with the MinIO root credentials
  const bucket = env.S3_PUBLIC_BUCKET || 'thali-public';
  const images = JSON.parse(readFileSync(resolve(DATA, 'images.json'), 'utf8')) as ImageRow[];
  const avatars = JSON.parse(readFileSync(resolve(DATA, 'avatars.json'), 'utf8')) as AvatarRow[];
  const jobs: Job[] = [
    ...images.map((i) => ({ id: i.id, group: 'pool' as const, file: resolve(CACHE, 'pool', `${i.id}.jpg`), key: poolKeyOf(i.id), urls: [i.url, ...(i.thumbUrl ? [i.thumbUrl] : [])] })),
    ...avatars.map((a) => {
      const key = avatarKeyOf(a.id, a.gender);
      return { id: a.id, group: 'avatars' as const, file: resolve(CACHE, key.replace('images/', '')), key, urls: [a.url, ...(a.thumbUrl ? [a.thumbUrl] : [])] };
    }),
  ];
  const t0 = Date.now();
  const cached = (j: Job) => existsSync(j.file) && statSync(j.file).size > 0;
  const missing = jobs.filter((j) => !cached(j));
  log(`[seed:images] ${jobs.length} images (${images.length} photos + ${avatars.length} avatars), ${jobs.length - missing.length} cached, ${missing.length} to download\n`);
  let downloaded = 0;
  let failedDl = 0;
  if (!opts.offline && missing.length) {
    await pool(missing, concurrency, async (j) => {
      if (await download(j, log)) downloaded++;
      else {
        failedDl++;
        log(`  skip ${j.id}: download failed\n`);
      }
      const done = downloaded + failedDl;
      if (done % 100 === 0) log(`  downloaded ${downloaded}/${missing.length} (${failedDl} failed, ${Math.round((Date.now() - t0) / 1000)} s)\n`);
    });
  }
  log(`[seed:images] download: ${downloaded} new, ${failedDl} failed (${Math.round((Date.now() - t0) / 1000)} s)\n`);

  const manifest: ImageManifest = { version: 1, bucket, generatedAt: new Date().toISOString(), pool: {}, avatars: {}, failed: [] };
  if (opts.upload !== false) {
    const port = env.MINIO_HOST_PORT || '9000';
    const s3 = new S3Client({
      endpoint: env.SEED_IMAGES_S3_ENDPOINT || `http://localhost:${port}`,
      region: env.S3_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: env.MINIO_ROOT_USER || 'thali', secretAccessKey: env.MINIO_ROOT_PASSWORD || '' },
      maxAttempts: 2,
    });
    let reachable = true;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: 'images/pool/.probe' }));
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404 && status !== 403) {
        reachable = false;
        log(`[seed:images] WARNING: MinIO not reachable (${(e as Error).message}); photos stay absolute URLs\n`);
      }
    }
    let uploaded = 0;
    let present = 0;
    if (reachable) {
      await pool(jobs, 8, async (j) => {
        if (!cached(j)) {
          manifest.failed.push(j.id);
          return;
        }
        try {
          let exists = true;
          try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: j.key }));
          } catch (e) {
            if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw e;
            exists = false;
          }
          if (!exists) {
            const body = readFileSync(j.file);
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key: j.key, Body: body, ContentType: sniff(body) ?? 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
            uploaded++;
          } else present++;
          manifest[j.group][j.id] = j.key;
        } catch (e) {
          manifest.failed.push(j.id);
          log(`  skip ${j.id}: upload failed (${(e as Error).message})\n`);
        }
      });
    } else manifest.failed.push(...jobs.map((j) => j.id));
    log(`[seed:images] bucket ${bucket}: ${uploaded} uploaded, ${present} already present, ${manifest.failed.length} not mirrored\n`);
  } else {
    // download-only: the bucket was not checked, so keep the last manifest as it is
    log(`[seed:images] --no-upload: cache filled, manifest left unchanged (${Math.round((Date.now() - t0) / 1000)} s)\n`);
    return existsSync(MANIFEST_PATH) ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ImageManifest) : { ...manifest, failed: jobs.map((j) => j.id) };
  }
  manifest.failed.sort();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 1)}\n`);
  log(`[seed:images] manifest ${MANIFEST_PATH}: ${Object.keys(manifest.pool).length} photos + ${Object.keys(manifest.avatars).length} avatars mirrored (${Math.round((Date.now() - t0) / 1000)} s)\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--concurrency');
  mirrorSeedImages({
    upload: !args.includes('--no-upload'),
    offline: args.includes('--offline'),
    ...(ci >= 0 ? { concurrency: Number(args[ci + 1]) } : {}),
  }).catch((e: unknown) => {
    process.stderr.write(`[seed:images] ${(e as Error).message}\n`);
    process.exit(/^Refusing/.test((e as Error).message) ? 1 : 0); // never block the seed on images, but do refuse non-demo stacks
  });
}
