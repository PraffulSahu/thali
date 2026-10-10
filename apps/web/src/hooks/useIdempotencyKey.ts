/**
 * Idempotency key per logical attempt (LLD §1.4). The key stays the same across re-renders, double clicks
 * and retries of the SAME attempt, so the server replays instead of creating duplicates; call `renew()` after
 * success (or when the user changes what they are submitting, e.g. the cart changed).
 *
 *   const idem = useIdempotencyKey();
 *   const pay = useMutation({
 *     mutationFn: (body) => api('/checkouts', { method: 'POST', body, idempotencyKey: idem.key }),
 *     onSuccess: () => idem.renew(),
 *   });
 */
import { useCallback, useState } from 'react';

/** 32 hex chars from crypto.getRandomValues (works on insecure http origins where randomUUID is missing). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function useIdempotencyKey(): { key: string; renew: () => void } {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return { key, renew };
}
