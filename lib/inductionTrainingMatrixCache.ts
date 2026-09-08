import SystemCache from '@/models/SystemCache';
import { pruneSupersededSystemCache } from '@/lib/systemCachePrune';

// Bump the version suffix whenever the payload shape changes so stale snapshots
// (memory or persisted) are ignored after a deploy.
const CACHE_FAMILY = 'induction-training-matrix-overview';
const CACHE_VERSION = 'v4';
const CACHE_KEY = `${CACHE_FAMILY}:${CACHE_VERSION}`;

export type InductionTrainingMatrixCacheEntry = { computedAt: number; payload: unknown };

type MemoryCacheEntry = { key: string; computedAt: number; payload: unknown };

function getMemoryEntry(): InductionTrainingMatrixCacheEntry | null {
  const store = (globalThis as { __itm_overview_cache?: MemoryCacheEntry }).__itm_overview_cache;
  if (!store || store.key !== CACHE_KEY) return null;
  return { computedAt: store.computedAt, payload: store.payload };
}

function setMemoryEntry(payload: unknown, computedAt: number) {
  (globalThis as { __itm_overview_cache?: MemoryCacheEntry }).__itm_overview_cache = {
    key: CACHE_KEY,
    computedAt,
    payload,
  };
}

export function setMemoryCached(payload: unknown) {
  setMemoryEntry(payload, Date.now());
}

/**
 * Returns the cached entry (payload + computedAt) from memory, falling back to
 * the durable MongoDB snapshot. Reading the persisted snapshot requires an
 * active DB connection (callers connect before invoking this).
 */
export async function getInductionTrainingMatrixCacheEntry(): Promise<InductionTrainingMatrixCacheEntry | null> {
  const mem = getMemoryEntry();
  if (mem) return mem;

  try {
    const doc = await SystemCache.findOne({ key: CACHE_KEY }).lean<{ payload: unknown; computedAt?: number }>();
    if (doc && doc.payload) {
      const computedAt = doc.computedAt || 0;
      setMemoryEntry(doc.payload, computedAt);
      return { computedAt, payload: doc.payload };
    }
  } catch {
    // Persisted cache is best-effort; ignore read failures.
  }
  return null;
}

/** Backwards-compatible accessor used by other routes — returns just the payload. */
export async function getInductionTrainingMatrixCached(): Promise<unknown | null> {
  const entry = await getInductionTrainingMatrixCacheEntry();
  return entry ? entry.payload : null;
}

export async function setInductionTrainingMatrixCached(payload: unknown) {
  const computedAt = Date.now();
  setMemoryEntry(payload, computedAt);
  try {
    await SystemCache.updateOne(
      { key: CACHE_KEY },
      { $set: { payload, computedAt } },
      { upsert: true },
    );
    void pruneSupersededSystemCache(CACHE_FAMILY, CACHE_VERSION);
  } catch {
    // Persisting is best-effort; the in-memory copy still serves requests.
  }
}

export async function invalidateInductionTrainingMatrixCache() {
  // Clear the in-memory copy so we don't keep serving it as "fresh".
  (globalThis as { __itm_overview_cache?: MemoryCacheEntry }).__itm_overview_cache = undefined;
  try {
    // Mark the durable snapshot STALE (computedAt=0) rather than deleting it. The
    // next request then still serves this snapshot instantly and triggers a
    // background recompute — so no user ever blocks on a from-scratch rebuild
    // after an Update. The snapshot's data is briefly behind until the background
    // refresh lands; the user who clicked Update gets fresh data via ?refresh=1.
    await SystemCache.updateOne({ key: CACHE_KEY }, { $set: { computedAt: 0 } });
  } catch {
    // Best-effort.
  }
}
