/**
 * Image refs (MKT-10, gap analysis §3.2). Stored image fields (`images.cover`, `images.logo`,
 * `imageKey`, ...) hold either an object-storage key or an absolute `https://` URL on an allowlisted
 * host (seed/admin only). Views turn a ref into a browser URL with `resolveImageUrl`.
 */
import type { StorageProvider } from './storage.js';

/** Hosts allowed when `EXTERNAL_IMAGE_HOSTS` is unset. */
export const DEFAULT_EXTERNAL_IMAGE_HOSTS: readonly string[] = Object.freeze(['live.staticflickr.com', 'upload.wikimedia.org', 'randomuser.me']);

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Parse `EXTERNAL_IMAGE_HOSTS` (comma-separated hostnames; `*.example.com` = any subdomain of
 * example.com). Unset/blank → `DEFAULT_EXTERNAL_IMAGE_HOSTS`; `none` → `[]` (external images off).
 * Entries are trimmed, lowercased and deduped. Throws on a malformed entry (scheme, path, bare `*`).
 */
export function parseExternalImageHosts(env?: string | null): string[] {
  if (env === undefined || env === null || env.trim() === '') return [...DEFAULT_EXTERNAL_IMAGE_HOSTS];
  if (env.trim().toLowerCase() === 'none') return [];
  const out: string[] = [];
  for (const raw of env.split(',')) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    if (!HOST_RE.test(h)) throw new Error(`EXTERNAL_IMAGE_HOSTS: invalid host "${raw.trim()}" (use hostnames like cdn.example.com or *.example.com)`);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** Exact host, or `*.suffix` matching any subdomain of `suffix` (not `suffix` itself). */
export function isAllowedImageHost(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowHosts.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/**
 * Browser URL for an image ref:
 *  - empty/null → `null` (the UI shows placeholder art);
 *  - absolute `https://` URL on an allowlisted host (no credentials, default port) → unchanged;
 *  - any other absolute or protocol-relative URL → `null` (never rendered);
 *  - otherwise a storage key → `storage.publicUrl(ref)`.
 */
export function resolveImageUrl(
  storage: Pick<StorageProvider, 'publicUrl'>,
  ref: string | null | undefined,
  allowHosts: readonly string[],
): string | null {
  if (typeof ref !== 'string') return null;
  const r = ref.trim();
  if (!r) return null;
  if (r.startsWith('//') || SCHEME_RE.test(r)) {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return isAllowedImageHost(u.hostname, allowHosts) ? r : null;
  }
  return storage.publicUrl(r);
}
