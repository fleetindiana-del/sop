/**
 * Browser-side stale-while-revalidate store.
 *
 * The dashboard, training matrix and LMS portal each grew their own version of
 * this (see `lib/cache.ts`, `lib/lmsCache.ts`, the localStorage block in
 * `app/training-matrix/page.tsx`). This is the shared implementation for the
 * remaining pages, which had no browser cache at all and so showed a spinner
 * for the length of a full round-trip on every single visit.
 *
 * The contract is deliberately narrow: a cached payload is only ever used as
 * the *first* paint. Every read is followed by a network revalidation, so what
 * ends up on screen is always the server's current answer — the cache removes
 * the blank/spinner phase, it never decides what the data is.
 *
 * Entries live in localStorage (survives reloads and new tabs, unlike
 * sessionStorage) and are scoped by a caller-supplied key. Bump the version in
 * a key whenever the payload shape changes.
 */

const NAMESPACE = 'sop-cache:v1:';

/** Drop entries older than this on read — a payload nobody has looked at in a
 *  week is more likely to confuse than to help. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedEntry<T> {
  value: T;
  cachedAt: number;
}

function storageKey(key: string): string {
  return `${NAMESPACE}${key}`;
}

/** Last cached payload for `key`, or null when absent/expired/unreadable. */
export function readCachedValue<T>(key: string): CachedEntry<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry<T>;
    if (!parsed || typeof parsed.cachedAt !== 'number') return null;
    if (Date.now() - parsed.cachedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(storageKey(key));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Store `value` as the first-paint payload for `key`. Best-effort. */
export function writeCachedValue(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey(key),
      JSON.stringify({ value, cachedAt: Date.now() } satisfies CachedEntry<unknown>),
    );
  } catch {
    // Quota exceeded or storage disabled. Evict our own entries and give up —
    // caching is an optimisation, never a correctness requirement.
    dropCachedValues();
  }
}

/**
 * Remove cached payloads. With no argument every entry in the namespace goes;
 * with a prefix only the matching ones do.
 *
 * Call this after a mutation whose result the cached view would contradict, so
 * the next visit cannot paint the pre-edit answer even for one frame.
 */
export function dropCachedValues(keyPrefix?: string): void {
  if (typeof window === 'undefined') return;
  try {
    const prefix = keyPrefix ? storageKey(keyPrefix) : NAMESPACE;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
