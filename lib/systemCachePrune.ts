import SystemCache from '@/models/SystemCache';

/**
 * Delete snapshots left behind by earlier cache versions.
 *
 * The durable snapshot keys carry a version token (`training-matrix-overview:v58`,
 * `manage-sop-view:v12:durable:…`) that is bumped whenever the payload shape
 * changes. Nothing ever removed the previous version's document, so every bump
 * orphaned a ~1MB blob in `systemcaches` — the collection had grown to ~20MB of
 * which only a few hundred KB was live. That is dead weight in every backup,
 * every collection scan and the cluster's storage budget.
 *
 * Pruning happens after a successful write, once per process, and only ever
 * touches keys in the same family with a *different* version token, so an
 * in-flight read of the active snapshot is never affected.
 */

const pruned = new Set<string>();

export async function pruneSupersededSystemCache(
  family: string,
  activeVersion: string,
): Promise<void> {
  if (pruned.has(family)) return;
  pruned.add(family);

  try {
    // `[0-9]` rather than `\d`: the server-side string form of $regex does not
    // honour the escape reliably, and this reads the same either way.
    await SystemCache.deleteMany({
      key: { $regex: `^${escapeRegExp(family)}:v[0-9]+(:|$)` },
      $nor: [{ key: { $regex: `^${escapeRegExp(`${family}:${activeVersion}`)}(:|$)` } }],
    });
  } catch {
    // Housekeeping only — a failure here must never break a cache write.
    pruned.delete(family);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
