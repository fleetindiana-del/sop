import SystemCache from '@/models/SystemCache';

const CACHE_PREFIX = 'manage-sop-view:v12';
const MEMORY_CACHE_TTL_MS = 30 * 60 * 1000;

type MemoryEntry = { cachedAt: number; payload: unknown };

const g = global as typeof global & {
  __manageSopViewCacheVersion?: number;
  __manageSopViewCache?: Map<string, MemoryEntry>;
  __manageSopViewInflight?: Map<string, Promise<unknown>>;
};

export type ManageSopViewCacheEntry = { computedAt: number; payload: unknown };

function normalizeYear(year: number | 'all'): string {
  return year === 'all' ? 'all' : String(year);
}

function normalizeSearch(search: string): string {
  return String(search || '').trim().toLowerCase();
}

function getActiveVersion(): number {
  return g.__manageSopViewCacheVersion ?? 1;
}

function buildCacheKey(version: number, year: number | 'all', search: string): string {
  const y = normalizeYear(year);
  const q = normalizeSearch(search);
  return `${CACHE_PREFIX}:${version}:${y}:${encodeURIComponent(q)}`;
}

/**
 * Durable (MongoDB) key — deliberately omits the volatile in-memory version
 * counter so a snapshot persisted before a restart is still readable after it.
 * Invalidation deletes these by prefix.
 */
function buildDurableKey(year: number | 'all', search: string): string {
  const y = normalizeYear(year);
  const q = normalizeSearch(search);
  return `${CACHE_PREFIX}:durable:${y}:${encodeURIComponent(q)}`;
}

function getMemoryStore(): Map<string, MemoryEntry> {
  if (!g.__manageSopViewCache) g.__manageSopViewCache = new Map();
  return g.__manageSopViewCache;
}

function pruneMemoryStore(store: Map<string, MemoryEntry>) {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now - entry.cachedAt > MEMORY_CACHE_TTL_MS) {
      store.delete(key);
    }
  }
}

/** Fast, synchronous memory-only lookup (no DB round-trip). */
export function getManageSopViewMemoryEntry(
  year: number | 'all',
  search: string,
): ManageSopViewCacheEntry | null {
  const key = buildCacheKey(getActiveVersion(), year, search);
  const store = getMemoryStore();
  const memory = store.get(key);
  if (!memory) return null;
  if (Date.now() - memory.cachedAt > MEMORY_CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return { computedAt: memory.cachedAt, payload: memory.payload };
}

/**
 * Memory first, then the durable MongoDB snapshot. Reading the durable snapshot
 * needs an active DB connection (callers connect before invoking this).
 */
export async function getManageSopViewCacheEntry(
  year: number | 'all',
  search: string,
): Promise<ManageSopViewCacheEntry | null> {
  const mem = getManageSopViewMemoryEntry(year, search);
  if (mem) return mem;

  try {
    const doc = await SystemCache.findOne({ key: buildDurableKey(year, search) }).lean<{
      payload: unknown;
      computedAt?: number;
    }>();
    if (doc && doc.payload) {
      const computedAt = doc.computedAt || 0;
      // Warm the memory store so subsequent hits skip the DB.
      const memKey = buildCacheKey(getActiveVersion(), year, search);
      getMemoryStore().set(memKey, { cachedAt: computedAt, payload: doc.payload });
      return { computedAt, payload: doc.payload };
    }
  } catch {
    // Durable cache is best-effort.
  }
  return null;
}

/** Backwards-compatible memory-only accessor (returns just the payload). */
export async function getManageSopViewCached(
  year: number | 'all',
  search: string,
): Promise<unknown | null> {
  const entry = getManageSopViewMemoryEntry(year, search);
  return entry ? entry.payload : null;
}

export async function setManageSopViewCached(
  year: number | 'all',
  search: string,
  payload: unknown,
): Promise<void> {
  const computedAt = Date.now();
  const key = buildCacheKey(getActiveVersion(), year, search);
  const store = getMemoryStore();
  pruneMemoryStore(store);
  store.set(key, { cachedAt: computedAt, payload });

  try {
    await SystemCache.updateOne(
      { key: buildDurableKey(year, search) },
      { $set: { payload, computedAt } },
      { upsert: true },
    );
  } catch {
    // Persisting is best-effort; the in-memory copy still serves requests.
  }
}

export async function invalidateManageSopViewCache(): Promise<void> {
  // Bump the in-memory version (clears the memory store) and drop in-flight rebuilds.
  g.__manageSopViewCacheVersion = getActiveVersion() + 1;
  g.__manageSopViewCache = new Map();
  g.__manageSopViewInflight = new Map();
  try {
    // Mark every durable snapshot STALE (computedAt=0) instead of deleting them, so
    // the next visitor still serves a snapshot instantly and refreshes it in the
    // background — no user blocks on a from-scratch rebuild after an Update. The
    // user who clicked Update gets fresh data via the ?refresh=1 call.
    await SystemCache.updateMany(
      { key: { $regex: `^${CACHE_PREFIX}:durable:` } },
      { $set: { computedAt: 0 } },
    );
  } catch {
    // Best-effort.
  }
}

/** Deduplicate concurrent cold rebuilds for the same cache key. */
export async function runManageSopViewRebuildSingleflight<T>(
  year: number | 'all',
  search: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = buildCacheKey(getActiveVersion(), year, search);
  if (!g.__manageSopViewInflight) g.__manageSopViewInflight = new Map();
  const existing = g.__manageSopViewInflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fn().finally(() => {
    g.__manageSopViewInflight?.delete(key);
  });
  g.__manageSopViewInflight.set(key, promise);
  return promise;
}
