/**
 * Avatars (IDN-3), same pattern as marketplace uploads: the browser PUTs straight to the public bucket
 * with a presigned URL; `PATCH /me {avatarKey}` then verifies the object (key under the caller's own
 * prefix, exists, ≤ 2 MB, magic bytes jpeg/png/webp via service-kit `verifyUpload`) before storing it.
 * Invalid objects are deleted and the request fails with 422 FILE_INVALID.
 *
 * `PATCH /me` only ever accepts upload keys. Absolute https refs (EXTERNAL_IMAGE_HOSTS) come from seed
 * writes only and are resolved by `resolveImageUrl` in the views.
 */
import { randomUUID } from 'node:crypto';
import { DomainError } from '@thali/contracts';
import { verifyUpload, type PresignedPut, type StorageProvider } from '@thali/service-kit';
import type { IdentityConfig } from '../config.js';

export const AVATAR_RULE = { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 2 * 1024 * 1024 } as const;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export const avatarPrefix = (userId: string) => `users/${userId}/avatars/`;

export interface AvatarPresign {
  key: string;
  bucket: 'public';
  upload: PresignedPut;
}

export async function presignAvatar(
  storage: StorageProvider,
  config: Pick<IdentityConfig, 'S3_PUBLIC_BUCKET'>,
  userId: string,
  opts: { contentType: string; sizeBytes: number },
): Promise<AvatarPresign> {
  const contentType = opts.contentType.toLowerCase();
  if (!(AVATAR_RULE.types as readonly string[]).includes(contentType)) {
    throw new DomainError('FILE_INVALID', `Content type ${contentType} is not allowed for an avatar`, undefined, { allowedTypes: AVATAR_RULE.types });
  }
  if (opts.sizeBytes <= 0 || opts.sizeBytes > AVATAR_RULE.maxBytes) {
    throw new DomainError('FILE_INVALID', `File must be between 1 and ${AVATAR_RULE.maxBytes} bytes`, undefined, { maxBytes: AVATAR_RULE.maxBytes });
  }
  const key = `${avatarPrefix(userId)}${randomUUID()}.${EXT[contentType]}`;
  const upload = await storage.presignPut({
    bucket: config.S3_PUBLIC_BUCKET,
    key,
    contentType,
    maxBytes: AVATAR_RULE.maxBytes,
    contentLength: opts.sizeBytes,
  });
  return { key, bucket: 'public', upload };
}

/** Verify an uploaded avatar before attaching it; deletes the object and throws 422 FILE_INVALID when invalid. */
export async function verifyAvatar(
  storage: StorageProvider,
  config: Pick<IdentityConfig, 'S3_PUBLIC_BUCKET'>,
  userId: string,
  key: string,
): Promise<void> {
  if (!key.startsWith(avatarPrefix(userId)) || key.includes('..')) {
    throw new DomainError('FILE_INVALID', 'Upload key does not belong to this account');
  }
  const bucket = config.S3_PUBLIC_BUCKET;
  const result = await verifyUpload(storage, { bucket, key, maxBytes: AVATAR_RULE.maxBytes, allowedTypes: [...AVATAR_RULE.types] });
  if (!result.ok) {
    await storage.delete(bucket, key).catch(() => undefined);
    throw new DomainError('FILE_INVALID', result.reason);
  }
}

/** Best-effort removal of a replaced avatar (only our own upload keys, never external URLs). */
export async function deleteOldAvatar(storage: StorageProvider, config: Pick<IdentityConfig, 'S3_PUBLIC_BUCKET'>, userId: string, key: string | null | undefined): Promise<void> {
  if (!key || !key.startsWith(avatarPrefix(userId))) return;
  await storage.delete(config.S3_PUBLIC_BUCKET, key).catch(() => undefined);
}
