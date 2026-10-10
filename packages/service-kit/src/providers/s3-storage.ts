/**
 * StorageProvider on AWS SDK v3 (S3, or MinIO via `endpoint` + path-style addressing).
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '@thali/contracts';
import type { ObjectHead, PresignedGet, PresignedPut, PresignPutInput, StorageProvider } from './storage.js';

export interface S3StorageOptions {
  /** e.g. `http://localhost:9000` (MinIO). When set, `forcePathStyle` defaults to true. */
  endpoint?: string;
  region: string;
  /** Omit both to use the default AWS credential chain (IAM role). */
  accessKeyId?: string;
  secretAccessKey?: string;
  publicBucket: string;
  /** e.g. CDN or `http://localhost:9000/thali-public`. */
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export function createS3Storage(opts: S3StorageOptions): StorageProvider {
  const client = new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
    // no SDK-default CRC32 checksum params in presigned URLs (browsers cannot supply them)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  const isNotFound = (err: unknown) => {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
  };

  return {
    async presignPut(input: PresignPutInput): Promise<PresignedPut> {
      const expiresSec = input.expiresSec ?? 300;
      const len = input.contentLength;
      if (!Number.isInteger(len) || len <= 0 || len > input.maxBytes) {
        throw new DomainError('FILE_INVALID', `File size must be declared and between 1 and ${input.maxBytes} bytes`, undefined, {
          maxBytes: input.maxBytes,
        });
      }
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: input.bucket, Key: input.key, ContentType: input.contentType, ContentLength: len }),
        { expiresIn: expiresSec, signableHeaders: new Set(['content-type', 'content-length']) },
      );
      // content-length is not returned: browsers forbid setting it and derive it from the body
      const headers: Record<string, string> = { 'content-type': input.contentType };
      return { url, method: 'PUT', headers, expiresAt: new Date(Date.now() + expiresSec * 1000).toISOString(), maxBytes: input.maxBytes };
    },

    async presignGet({ bucket, key, expiresSec = 300 }): Promise<PresignedGet> {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec });
      return { url, expiresAt: new Date(Date.now() + expiresSec * 1000).toISOString() };
    },

    async head(bucket, key): Promise<ObjectHead | null> {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { contentType: out.ContentType ?? 'application/octet-stream', size: Number(out.ContentLength ?? 0) };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readHead(bucket, key, bytes): Promise<Buffer> {
      if (bytes <= 0) return Buffer.alloc(0);
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
      if (!out.Body) return Buffer.alloc(0);
      return Buffer.from(await out.Body.transformToByteArray());
    },

    publicUrl(key) {
      if (opts.publicBaseUrl) return `${opts.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`;
      if (opts.endpoint) return `${opts.endpoint.replace(/\/+$/, '')}/${opts.publicBucket}/${encodeKey(key)}`;
      return `https://${opts.publicBucket}.s3.${opts.region}.amazonaws.com/${encodeKey(key)}`;
    },

    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export interface StorageConfig {
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_PUBLIC_BUCKET: string;
  S3_PUBLIC_BASE_URL?: string;
}

/** `createS3Storage` from LLD 12 env vars (`S3_ENDPOINT` set → MinIO path-style). */
export function createStorageProvider(config: StorageConfig): StorageProvider {
  return createS3Storage({
    endpoint: config.S3_ENDPOINT || undefined,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY || undefined,
    publicBucket: config.S3_PUBLIC_BUCKET,
    publicBaseUrl: config.S3_PUBLIC_BASE_URL || undefined,
  });
}
