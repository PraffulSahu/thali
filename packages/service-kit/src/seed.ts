/**
 * Demo seed helpers (Node only; import from `@thali/service-kit/seed`).
 *
 * Every service owns a `src/seed.ts` that writes ONLY its own database, with deterministic ids from
 * `seedId()` (`@thali/contracts/seed`) so cross-service references line up without any lookups.
 * Seeds are idempotent: a document whose `_id` already exists is left untouched (never overwritten, so
 * demo state changed through the app survives a re-seed); a second run reports 0 inserts.
 */
import { pathToFileURL } from 'node:url';
import type { Connection, Model } from 'mongoose';
import { connectMongo } from './data/mongo.js';

export interface SeedTally {
  inserted: number;
  existing: number;
}
/** Per-collection counts. */
export type SeedReport = Record<string, SeedTally>;

export class SeedConflictError extends Error {}

/** Demo data may only ever be written in demo mode. */
export function assertDemoSeedAllowed(appMode: string | undefined = process.env.APP_MODE): void {
  if (appMode !== 'demo') {
    throw new Error(`Refusing to seed: APP_MODE=${appMode ?? '(unset)'} (demo data is only allowed with APP_MODE=demo)`);
  }
}

/**
 * Insert each doc unless a document with its `_id` exists. Uses the service's own model, so schema
 * defaults, casting and validation apply. `createdAt`/`updatedAt` default to now but may be given
 * (back-dated demo history). A unique-index clash with a non-seed document (e.g. a phone that signed
 * in before seeding) throws `SeedConflictError` naming the key.
 */
export async function ensureDocs(
  model: Model<any>, // any service model
  docs: ReadonlyArray<Record<string, unknown>>,
  report: SeedReport,
  label: string = model.collection.collectionName,
): Promise<void> {
  const tally = (report[label] ??= { inserted: 0, existing: 0 });
  for (const d of docs) {
    if (d._id === undefined || d._id === null) throw new Error(`seed ${label}: every document needs a deterministic _id`);
    if (await model.exists({ _id: d._id })) {
      tally.existing++;
      continue;
    }
    const now = new Date();
    const doc = new model({ createdAt: now, updatedAt: now, ...d });
    try {
      await doc.save({ timestamps: false });
      tally.inserted++;
    } catch (e) {
      const err = e as { code?: number; keyValue?: Record<string, unknown> };
      if (err.code === 11000) {
        if (await model.exists({ _id: d._id })) {
          tally.existing++; // a concurrent seed run inserted it
          continue;
        }
        throw new SeedConflictError(
          `seed ${label} ${String(d._id)}: conflicts with an existing non-seed document ${JSON.stringify(err.keyValue ?? {})}. ` +
            'Reset the demo data (npm run stack:down -- -v) or remove that document, then re-run the seed.',
        );
      }
      throw e;
    }
  }
}

export interface EnsureDocsBulkOptions {
  /** Documents per `find` + `insertMany` round trip. Default 1000. */
  chunk?: number;
  /** Report key. Default: the collection name. */
  label?: string;
}

type SeedDoc = Record<string, unknown>;

/**
 * Bulk variant of `ensureDocs` for large generated seeds (gap analysis §5.2): per chunk,
 * `find({_id:{$in}}, {_id:1})` then `insertMany(missing, {ordered:false, timestamps:false})`.
 * Same rules: never overwrites; every doc needs a deterministic `_id`; the whole chunk is validated
 * through the model before anything is written (a validation error throws and the chunk is not written);
 * explicit `createdAt`/`updatedAt` are kept, else both default to now; a duplicate `_id` (repeated in
 * the input, or inserted concurrently) counts as existing; a unique clash with a non-seed document
 * throws `SeedConflictError` naming the key (after the rest of the chunk has been inserted).
 * `docs` may be an array, any iterable, or an async iterable (stream the generation to keep memory flat).
 */
export async function ensureDocsBulk(
  model: Model<any>, // any service model
  docs: Iterable<SeedDoc> | AsyncIterable<SeedDoc>,
  report: SeedReport,
  opts: EnsureDocsBulkOptions = {},
): Promise<void> {
  const label = opts.label ?? model.collection.collectionName;
  const chunkSize = opts.chunk ?? 1000;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error(`seed ${label}: chunk must be a positive integer`);
  const tally = (report[label] ??= { inserted: 0, existing: 0 });

  async function flush(chunk: SeedDoc[]): Promise<void> {
    const found = await model.find({ _id: { $in: chunk.map((d) => d._id) } }, { _id: 1 }).lean<{ _id: unknown }[]>();
    const known = new Set(found.map((f) => String(f._id)));
    const now = new Date();
    const pending: { id: unknown; doc: InstanceType<Model<any>> }[] = [];
    for (const d of chunk) {
      const doc = new model({ createdAt: now, updatedAt: now, ...d });
      const key = String(doc._id);
      if (known.has(key)) {
        tally.existing++;
        continue;
      }
      known.add(key); // a repeat of this _id later in the input counts as existing
      pending.push({ id: d._id, doc });
    }
    if (pending.length === 0) return;
    await Promise.all(pending.map((p) => p.doc.validate()));
    try {
      // `timestamps: false` (honoured by mongoose insertMany, not in its typings): keep explicit createdAt/updatedAt
      const insertOpts = { ordered: false, timestamps: false };
      await model.insertMany(
        pending.map((p) => p.doc),
        insertOpts,
      );
      tally.inserted += pending.length;
    } catch (e) {
      const writeErrors = (e as { writeErrors?: unknown[] }).writeErrors;
      if (!Array.isArray(writeErrors) || writeErrors.length === 0) throw e;
      tally.inserted += pending.length - writeErrors.length;
      let conflict: SeedConflictError | undefined;
      for (const raw of writeErrors) {
        const we = raw as { index?: number; code?: number; err?: { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown>; errmsg?: string } };
        const code = we.err?.code ?? we.code;
        if (code !== 11000) throw e;
        // bulk write errors carry no keyPattern/keyValue: parse `index: <name> dup key: { ... }` from errmsg
        const msg = we.err?.errmsg ?? '';
        const index = /index: (\S+)/.exec(msg)?.[1];
        const dupKey = we.err?.keyValue ? JSON.stringify(we.err.keyValue) : (/dup key: (\{.*\})/.exec(msg)?.[1] ?? '{}');
        const p = pending[we.index ?? -1];
        const idClash = index === '_id_' || Object.keys(we.err?.keyPattern ?? {}).join() === '_id';
        if (idClash || (p && (await model.exists({ _id: p.id })))) {
          tally.existing++; // concurrent seed run (or repeated _id) inserted it
          continue;
        }
        conflict ??= new SeedConflictError(
          `seed ${label} ${String(p?.id)}: conflicts with an existing non-seed document ${dupKey}${index ? ` (index ${index})` : ''}. ` +
            'Reset the demo data (npm run stack:down -- -v) or remove that document, then re-run the seed.',
        );
      }
      if (conflict) throw conflict;
    }
  }

  let buf: SeedDoc[] = [];
  for await (const d of docs) {
    if (d._id === undefined || d._id === null) throw new Error(`seed ${label}: every document needs a deterministic _id`);
    buf.push(d);
    if (buf.length >= chunkSize) {
      await flush(buf);
      buf = [];
    }
  }
  if (buf.length) await flush(buf);
}

export const totalInserted = (report: SeedReport) => Object.values(report).reduce((n, t) => n + t.inserted, 0);

/** Human summary + one machine-readable line (`SEED_RESULT {...}`) for `scripts/seed.ts`. */
export function printSeedReport(service: string, report: SeedReport, write: (s: string) => void = (s) => process.stdout.write(s)): void {
  const rows = Object.entries(report);
  write(`[seed:${service}] ${rows.length ? '' : 'nothing to seed'}\n`);
  for (const [label, t] of rows) write(`  ${label.padEnd(24)} inserted ${String(t.inserted).padStart(3)}   existing ${String(t.existing).padStart(3)}\n`);
  write(`SEED_RESULT ${JSON.stringify({ service, inserted: totalInserted(report), report })}\n`);
}

/** True when `metaUrl` (pass `import.meta.url`) is the script node was started with. */
export function isMainModule(metaUrl: string): boolean {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

export interface SeedCliOptions {
  service: string;
  dbName: string;
  /** Create collections/indexes first (the service's boot-time init). */
  init?: (conn: Connection) => Promise<void>;
  run: (conn: Connection) => Promise<SeedReport>;
}

/** CLI wrapper: demo guard → connect (MONGO_URI) → init → run → report → exit code. */
export async function runSeedCli(opts: SeedCliOptions): Promise<void> {
  try {
    assertDemoSeedAllowed();
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is required');
    const conn = await connectMongo(uri, opts.dbName);
    try {
      if (opts.init) await opts.init(conn);
      printSeedReport(opts.service, await opts.run(conn));
    } finally {
      await conn.close();
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[seed:${opts.service}] FAILED: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

export interface SeedObject {
  bucket: string;
  key: string;
  contentType: string;
  body: Buffer;
}

/**
 * Upload demo files (KYC placeholders, cover images) through the server-side S3 endpoint (presign + PUT,
 * so no extra SDK surface). Objects that already exist are left alone (idempotent).
 */
export async function uploadSeedObjects(
  storage: { endpoint?: string; region: string; accessKeyId?: string; secretAccessKey?: string; publicBucket: string },
  objects: readonly SeedObject[],
  report: SeedReport,
  label = 'objects (S3)',
): Promise<void> {
  const tally = (report[label] ??= { inserted: 0, existing: 0 });
  // No publicEndpoint: the URL must be reachable from this process, not from a browser.
  const { createS3Storage } = await import('./providers/s3-storage.js');
  const s3 = createS3Storage({ ...storage });
  for (const o of objects) {
    if (await s3.head(o.bucket, o.key)) {
      tally.existing++;
      continue;
    }
    const p = await s3.presignPut({ bucket: o.bucket, key: o.key, contentType: o.contentType, maxBytes: o.body.length, contentLength: o.body.length });
    const res = await fetch(p.url, { method: 'PUT', headers: p.headers, body: o.body });
    if (!res.ok) throw new Error(`seed upload ${o.bucket}/${o.key} failed: HTTP ${res.status}`);
    tally.inserted++;
  }
}

/** Smallest well-formed one-page PDF (passes magic-byte sniffing), labelled as a demo document. */
export function demoPdf(title: string): Buffer {
  const text = `DEMO DOCUMENT - ${title}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
