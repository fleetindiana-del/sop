import mongoose, { Schema } from "mongoose";
import SOP, { type ISOP } from "@/models/SOP";
import type { RegistrySOP } from "@/lib/types";
import { groupSOPRecords, sopFamilyGroupKey } from "@/lib/sop-utils";
import { SOP_LIST_EXCLUDE } from "@/lib/sop-list-projection";

/* ─── Persistent grouped-registry cache ──────────────────────────────────
 * The in-memory cache in lib/cache.ts is per-process, so a cold serverless
 * container starts empty and would re-scan + re-group the entire SOP
 * collection (~56MB) — the multi-second cold-start penalty. This stores the
 * already-grouped registry in a single Mongo doc so any container, warm or
 * cold, can read a few-hundred-KB blob instead.
 *
 * Cross-container invalidation without touching the ~20 mutation call sites:
 * we stamp the cache with a cheap "signature" of the collection at build time
 * (document count + the newest updatedAt). On read we recompute that signature
 * with two fast, indexed queries; if it differs, a write happened somewhere
 * (insert → count up, update → newer updatedAt, delete → count down) and we
 * treat the cache as stale. No mutation handler needs to know this exists. */

// Bump when grouped-registry computation logic changes (e.g. version-date rules).
// v6: stores `familyKeys` alongside `data` for incremental refresh.
const CACHE_KEY = "grouped-registry-v6";
const LEGACY_CACHE_KEYS = ["grouped-registry-v5", "grouped-registry-v4", "grouped-registry-v3", "grouped-registry-v2", "grouped-registry-v1"] as const;

interface Signature {
  count: number;
  maxUpdatedAt: number; // epoch ms; 0 when collection is empty
}

interface CacheDoc {
  key: string;
  data: RegistrySOP[];
  /** Family group key of each row in `data` (same order), for incremental refresh. */
  familyKeys?: string[];
  count: number;
  maxUpdatedAt: Date | null;
  builtAt: Date;
}

const cacheSchema = new Schema<CacheDoc>(
  {
    key: { type: String, required: true, unique: true },
    data: { type: Schema.Types.Mixed, required: true },
    familyKeys: { type: [String], default: undefined },
    count: { type: Number, required: true },
    maxUpdatedAt: { type: Date, default: null },
    builtAt: { type: Date, required: true },
  },
  { collection: "dashboard_grouped_cache", minimize: false },
);

const DashboardGroupedCache =
  (mongoose.models.DashboardGroupedCache as mongoose.Model<CacheDoc>) ||
  mongoose.model<CacheDoc>("DashboardGroupedCache", cacheSchema);

/** Newest updatedAt + document count — a cheap fingerprint of collection state.
 *  estimatedDocumentCount() is a metadata read; the findOne is index-backed by
 *  the declared `updatedAt: -1` index (run /api/admin/sync-indexes once). */
async function liveSignature(): Promise<Signature> {
  const [count, latest] = await Promise.all([
    SOP.estimatedDocumentCount(),
    SOP.findOne({}).select("updatedAt").sort({ updatedAt: -1 }).lean(),
  ]);
  return {
    count,
    maxUpdatedAt: latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0,
  };
}

/** Signature computed directly from the records we just scanned — exact, and
 *  free of a race against a mutation landing between scan and write. */
export function signatureFromRecords(
  records: Array<{ updatedAt?: Date | string }>,
): Signature {
  let maxUpdatedAt = 0;
  for (const r of records) {
    const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    if (t > maxUpdatedAt) maxUpdatedAt = t;
  }
  return { count: records.length, maxUpdatedAt };
}

/** Returns the cached grouped registry if it still matches live collection
 *  state, else null (caller should rebuild). Never throws — a cache-layer
 *  failure must degrade to a normal scan, not break the dashboard. */
/**
 * This process's last known-good registry with the signature it matches. The
 * cache doc is ~1.5MB and the M0 link moves ~100KB/s, so re-reading it after
 * every in-process invalidation cost ~17s; the signature check below decides
 * whether this copy is still current with two tiny queries instead.
 */
type RegistryBase = Signature & { data: RegistrySOP[]; familyKeys?: string[] };
let memoryBase: RegistryBase | null = null;

function sameSignature(a: Signature, b: Signature): boolean {
  return a.count === b.count && a.maxUpdatedAt === b.maxUpdatedAt;
}

export async function readPersistentGroupedCache(): Promise<RegistrySOP[] | null> {
  try {
    const live = await liveSignature();
    if (memoryBase && sameSignature(memoryBase, live)) return memoryBase.data;

    const doc = await DashboardGroupedCache.findOne({ key: CACHE_KEY }).lean();
    if (!doc) return null;
    const stored: Signature = {
      count: doc.count,
      maxUpdatedAt: doc.maxUpdatedAt ? new Date(doc.maxUpdatedAt).getTime() : 0,
    };
    const data = doc.data as RegistrySOP[];
    // Remember it even when stale: it is the base the incremental refresh patches.
    memoryBase = { ...stored, data, familyKeys: doc.familyKeys };
    if (!sameSignature(stored, live)) return null;
    return data;
  } catch (e) {
    console.error("[persistentGroupedCache] read failed:", e);
    return null;
  }
}

/** Drop persisted grouped rows so the next load recomputes from live records. */
export async function invalidatePersistentGroupedCache(): Promise<void> {
  memoryBase = null;
  try {
    await DashboardGroupedCache.deleteMany({
      key: { $in: [CACHE_KEY, ...LEGACY_CACHE_KEYS] },
    });
  } catch (e) {
    console.error("[persistentGroupedCache] invalidate failed:", e);
  }
}

/** Family group key of each grouped row, taken from the records it was built from. */
export function familyKeysFor(
  rows: RegistrySOP[],
  records: Array<Pick<ISOP, "_id" | "identifier" | "sopBaseId">>,
): string[] {
  const byId = new Map(records.map((r) => [String(r._id), r]));
  return rows.map((row) => {
    const first = row.recordIds?.map((id) => byId.get(id)).find(Boolean);
    return sopFamilyGroupKey(first ?? { identifier: row.identifier, sopBaseId: undefined });
  });
}

/** Above this many changed records a full rescan is simpler than patching. */
const INCREMENTAL_MAX_CHANGED = 300;

/**
 * Bring a stale persisted registry up to date by regrouping only the SOP
 * families touched since it was built, instead of rescanning the whole
 * collection (64MB; 16-54s on Atlas M0). Every registry-relevant SOP write goes
 * through Mongoose and bumps `updatedAt`, so `updatedAt >= stored max` finds
 * all edits and inserts; a delete shows up as a count mismatch, which falls
 * back to a full rebuild. Returns null whenever patching is not provably safe.
 */
export async function refreshPersistentGroupedCacheIncrementally(): Promise<RegistrySOP[] | null> {
  try {
    // Normally readPersistentGroupedCache has just loaded the base into memory.
    let base = memoryBase;
    if (!base?.familyKeys) {
      const doc = await DashboardGroupedCache.findOne({ key: CACHE_KEY }).lean();
      if (!doc) return null;
      base = {
        count: doc.count,
        maxUpdatedAt: doc.maxUpdatedAt ? new Date(doc.maxUpdatedAt).getTime() : 0,
        data: doc.data as RegistrySOP[],
        familyKeys: doc.familyKeys,
      };
    }
    const rows = base.data;
    const keys = base.familyKeys;
    if (!Array.isArray(rows) || !Array.isArray(keys)) return null;
    if (keys.length !== rows.length || rows.some((r) => !Array.isArray(r.recordIds))) return null;

    const storedMax = new Date(base.maxUpdatedAt);
    const [live, changed] = await Promise.all([
      liveSignature(),
      SOP.find({ updatedAt: { $gte: storedMax } })
        .select(SOP_LIST_EXCLUDE)
        .limit(INCREMENTAL_MAX_CHANGED + 1)
        .lean<ISOP[]>(),
    ]);
    if (changed.length === 0 || changed.length > INCREMENTAL_MAX_CHANGED) return null;

    const rowByRecordId = new Map<string, number>();
    rows.forEach((row, i) => row.recordIds.forEach((id) => rowByRecordId.set(id, i)));
    const newCount = changed.filter((r) => !rowByRecordId.has(String(r._id))).length;
    // Anything else (a delete, or a write that skipped timestamps) → full rebuild.
    if (base.count + newCount !== live.count) return null;

    // Families to regroup: each changed record's current family, plus the
    // family it sat in before (an identifier edit can move it).
    const affected = new Set<string>();
    for (const r of changed) {
      affected.add(sopFamilyGroupKey(r));
      const i = rowByRecordId.get(String(r._id));
      if (i !== undefined) affected.add(keys[i]);
    }

    const changedIds = new Set(changed.map((r) => String(r._id)));
    const otherIds = [...new Set(
      rows.flatMap((row, i) => (affected.has(keys[i]) ? row.recordIds : []))
        .filter((id) => !changedIds.has(id)),
    )];
    const others = otherIds.length
      ? await SOP.find({ _id: { $in: otherIds } }).select(SOP_LIST_EXCLUDE).lean<ISOP[]>()
      : [];
    if (others.length !== otherIds.length) return null; // a record vanished meanwhile

    // ObjectId order ≈ the collection's natural order the full scan sees, so
    // each family's recordIds come out the same as a full rebuild.
    const records = [...changed, ...others].sort((a, b) =>
      String(a._id).localeCompare(String(b._id)),
    );
    const regrouped = groupSOPRecords(records);
    const regroupedKeys = familyKeysFor(regrouped, records);
    const replacement = new Map(regroupedKeys.map((k, i) => [k, regrouped[i]]));

    // Keep row order stable: patch families in place, drop emptied ones,
    // append newly formed ones.
    const data: RegistrySOP[] = [];
    const familyKeys: string[] = [];
    rows.forEach((row, i) => {
      const key = keys[i];
      if (!affected.has(key)) {
        data.push(row);
        familyKeys.push(key);
        return;
      }
      const next = replacement.get(key);
      if (next) {
        data.push(next);
        familyKeys.push(key);
        replacement.delete(key);
      }
    });
    for (const [key, row] of replacement) {
      data.push(row);
      familyKeys.push(key);
    }

    let maxUpdatedAt = storedMax.getTime();
    for (const r of changed) {
      const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (t > maxUpdatedAt) maxUpdatedAt = t;
    }
    void writePersistentGroupedCache(
      data,
      { count: base.count + newCount, maxUpdatedAt },
      familyKeys,
    );
    return data;
  } catch (e) {
    console.error("[persistentGroupedCache] incremental refresh failed:", e);
    return null;
  }
}

/** Upserts the grouped registry plus the signature it was built from. */
export async function writePersistentGroupedCache(
  items: RegistrySOP[],
  signature: Signature,
  familyKeys?: string[],
): Promise<void> {
  const keys = familyKeys && familyKeys.length === items.length ? familyKeys : undefined;
  memoryBase = { ...signature, data: items, familyKeys: keys };
  try {
    await DashboardGroupedCache.updateOne(
      { key: CACHE_KEY },
      {
        $set: {
          data: items,
          familyKeys: keys,
          count: signature.count,
          maxUpdatedAt: signature.maxUpdatedAt
            ? new Date(signature.maxUpdatedAt)
            : null,
          builtAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    console.error("[persistentGroupedCache] write failed:", e);
  }
}
