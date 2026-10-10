/**
 * Uploads (brief): browser PUTs straight to the bucket with a presigned URL; the server verifies
 * the object (exists, size, declared type, magic bytes via `file-type` on the first 4 KB) before it
 * is attached. Invalid objects are deleted and the request fails with 422 FILE_INVALID.
 *   IMAGE    → public bucket,  image/jpeg|png|webp,           ≤ 2 MB
 *   DOCUMENT → private bucket, application/pdf|image/jpeg|png, ≤ 5 MB
 */
import { randomUUID } from 'node:crypto';
import { DomainError } from '@thali/contracts';
import { verifyUpload, type PresignedPut, type StorageProvider } from '@thali/service-kit';
import type { MarketplaceConfig } from '../config.js';

export type UploadPurpose = 'IMAGE' | 'DOCUMENT';

export const UPLOAD_RULES: Record<UploadPurpose, { bucket: 'public' | 'private'; types: string[]; maxBytes: number; folder: string }> = {
  IMAGE: { bucket: 'public', types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 2 * 1024 * 1024, folder: 'images' },
  DOCUMENT: { bucket: 'private', types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024, folder: 'documents' },
};

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const bucketName = (config: MarketplaceConfig, b: 'public' | 'private') => (b === 'public' ? config.S3_PUBLIC_BUCKET : config.S3_PRIVATE_BUCKET);

export interface PresignResult {
  key: string;
  bucket: 'public' | 'private';
  upload: PresignedPut;
}

/** Validate the declared type/size and presign a PUT under `<prefix>/<folder>/<uuid>.<ext>`. */
export async function presignUpload(
  storage: StorageProvider,
  config: MarketplaceConfig,
  opts: { prefix: string; purpose: UploadPurpose; contentType: string; sizeBytes: number },
): Promise<PresignResult> {
  const rule = UPLOAD_RULES[opts.purpose];
  const contentType = opts.contentType.toLowerCase();
  if (!rule.types.includes(contentType)) {
    throw new DomainError('FILE_INVALID', `Content type ${contentType} is not allowed for ${opts.purpose}`, undefined, { allowedTypes: rule.types });
  }
  if (opts.sizeBytes <= 0 || opts.sizeBytes > rule.maxBytes) {
    throw new DomainError('FILE_INVALID', `File must be between 1 and ${rule.maxBytes} bytes`, undefined, { maxBytes: rule.maxBytes });
  }
  const key = `${opts.prefix}/${rule.folder}/${randomUUID()}.${EXT[contentType]}`;
  const upload = await storage.presignPut({
    bucket: bucketName(config, rule.bucket),
    key,
    contentType,
    maxBytes: rule.maxBytes,
    contentLength: opts.sizeBytes,
  });
  return { key, bucket: rule.bucket, upload };
}

/**
 * Verify an uploaded object before attaching it. The key must live under the owner's own prefix;
 * on failure the object is deleted and 422 FILE_INVALID is thrown.
 */
export async function verifyAttachment(
  storage: StorageProvider,
  config: MarketplaceConfig,
  opts: { prefix: string; purpose: UploadPurpose; key: string },
): Promise<void> {
  const rule = UPLOAD_RULES[opts.purpose];
  const expectedPrefix = `${opts.prefix}/${rule.folder}/`;
  if (!opts.key.startsWith(expectedPrefix) || opts.key.includes('..')) {
    throw new DomainError('FILE_INVALID', 'Upload key does not belong to this restaurant');
  }
  const bucket = bucketName(config, rule.bucket);
  const result = await verifyUpload(storage, { bucket, key: opts.key, maxBytes: rule.maxBytes, allowedTypes: rule.types });
  if (!result.ok) {
    await storage.delete(bucket, opts.key).catch(() => undefined);
    throw new DomainError('FILE_INVALID', result.reason);
  }
}
