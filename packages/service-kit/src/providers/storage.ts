/**
 * ObjectStorage port (HLD 6): S3 in production, MinIO locally (same API).
 *
 * Upload flow (browser → bucket directly):
 *  1. server: `presignPut({ bucket, key, contentType, maxBytes, contentLength })` → `{ url, method: 'PUT', headers, expiresAt }`.
 *     `contentLength` (the client-declared file size, required, 1..maxBytes else `FILE_INVALID`) and
 *     the content type are both signed (HLD 8): a different `Content-Type` or a body of any other
 *     size → 403 from S3/MinIO. The client never sets Content-Length itself (it is derived from the body).
 *  2. client: `fetch(url, { method: 'PUT', headers, body: file })`.
 *  3. server (on "upload complete" call): `verifyUpload(storage, { bucket, key, maxBytes, allowedTypes })`
 *     → HEAD (exists, size ≤ maxBytes, declared type allowed) + magic-byte sniff of the first bytes
 *     (`readHead`) must match the declared type. On `{ ok: false }` delete the object and reject
 *     with `FILE_INVALID`.
 */
import { fileTypeFromBuffer } from 'file-type';

export interface PresignPutInput {
  bucket: string;
  key: string;
  contentType: string;
  /** Upper bound for `contentLength` (and re-checked by `verifyUpload`). */
  maxBytes: number;
  /** Exact file size declared by the client (bytes, 1..maxBytes); signed into the URL — the upload must be exactly this size. */
  contentLength: number;
  /** Default 300 s. */
  expiresSec?: number;
}

export interface PresignedPut {
  url: string;
  method: 'PUT';
  /** Send exactly these headers with the PUT. */
  headers: Record<string, string>;
  /** ISO time. */
  expiresAt: string;
  maxBytes: number;
}

export interface PresignedGet {
  url: string;
  expiresAt: string;
}

export interface ObjectHead {
  contentType: string;
  size: number;
}

export interface StorageProvider {
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  /** Default `expiresSec` 300 (admin document links expire in 5 min, LLD 14). */
  presignGet(input: { bucket: string; key: string; expiresSec?: number }): Promise<PresignedGet>;
  /** `null` if the object does not exist. */
  head(bucket: string, key: string): Promise<ObjectHead | null>;
  /** First `bytes` bytes (Range GET). */
  readHead(bucket: string, key: string, bytes: number): Promise<Buffer>;
  /** Public URL of a key in the public bucket. */
  publicUrl(key: string): string;
  delete(bucket: string, key: string): Promise<void>;
}

export interface VerifyUploadInput {
  bucket: string;
  key: string;
  maxBytes: number;
  /** e.g. `['image/jpeg','image/png','image/webp']`, `['application/pdf','image/jpeg','image/png']`. */
  allowedTypes: string[];
}

export type VerifyUploadResult = { ok: true; contentType: string; size: number } | { ok: false; reason: string };

/** Bytes read for magic-number detection. */
export const SNIFF_BYTES = 4100;

/**
 * Post-upload verification: exists, 0 < size ≤ maxBytes, declared Content-Type allowed, and the
 * sniffed type of the leading bytes equals the declared type (types `file-type` cannot sniff, e.g.
 * text formats, are rejected). Does not delete; the caller decides.
 */
export async function verifyUpload(storage: StorageProvider, input: VerifyUploadInput): Promise<VerifyUploadResult> {
  const head = await storage.head(input.bucket, input.key);
  if (!head) return { ok: false, reason: 'upload not found' };
  if (head.size <= 0) return { ok: false, reason: 'file is empty' };
  if (head.size > input.maxBytes) return { ok: false, reason: `file too large (${head.size} > ${input.maxBytes} bytes)` };
  const declared = head.contentType.split(';')[0]!.trim().toLowerCase();
  if (!input.allowedTypes.includes(declared)) return { ok: false, reason: `content type ${declared} not allowed` };
  const bytes = await storage.readHead(input.bucket, input.key, Math.min(SNIFF_BYTES, head.size));
  const sniffed = await fileTypeFromBuffer(bytes);
  if (!sniffed || sniffed.mime !== declared) {
    return { ok: false, reason: `file content does not match declared type ${declared}${sniffed ? ` (looks like ${sniffed.mime})` : ''}` };
  }
  return { ok: true, contentType: declared, size: head.size };
}
