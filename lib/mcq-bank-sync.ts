import MCQBank from "@/models/MCQBank";
import { sopFamilyIdentifierRegex } from "@/lib/sop-utils";
import type { AggregatedMcqFamily } from "@/lib/mcq-bank-utils";

const OBSOLETE_MCQ_REASON = "Moved to Obsolete MCQs — no active SOP in registry";

export async function markMcqBanksObsoleteForIdentifier(
  identifier: string,
  reason = OBSOLETE_MCQ_REASON,
): Promise<number> {
  const now = new Date();
  const result = await MCQBank.updateMany(
    { sopIdentifier: sopFamilyIdentifierRegex(identifier), isObsolete: { $ne: true } },
    { $set: { isObsolete: true, obsoleteAt: now, obsoleteReason: reason } },
  );
  return result.modifiedCount;
}

export async function reviveMcqBanksForIdentifier(identifier: string): Promise<number> {
  const result = await MCQBank.updateMany(
    { sopIdentifier: sopFamilyIdentifierRegex(identifier), isObsolete: true },
    { $set: { isObsolete: false }, $unset: { obsoleteAt: "", obsoleteReason: "" } },
  );
  return result.modifiedCount;
}

/** Persist orphan MCQ families as obsolete so they leave active MCQ counts. */
export async function syncOrphanMcqBanks(
  obsoleteFamilies: AggregatedMcqFamily[],
): Promise<{ marked: number; identifiers: string[] }> {
  if (!obsoleteFamilies.length) return { marked: 0, identifiers: [] };

  const now = new Date();
  let marked = 0;
  const identifiers: string[] = [];

  for (const fam of obsoleteFamilies) {
    const regex = sopFamilyIdentifierRegex(fam.identifier);
    const result = await MCQBank.updateMany(
      { sopIdentifier: regex, isObsolete: { $ne: true } },
      { $set: { isObsolete: true, obsoleteAt: now, obsoleteReason: OBSOLETE_MCQ_REASON } },
    );
    if (result.modifiedCount > 0) {
      marked += result.modifiedCount;
      identifiers.push(fam.identifier);
    }
  }

  return { marked, identifiers };
}

/** Reconcile MCQ bank obsolete flags against active SOP family keys. */
export async function reconcileMcqBankObsoleteFlags(
  activeFamilyKeys: Set<string>,
  mcqFamilies: Map<string, AggregatedMcqFamily>,
): Promise<{ marked: number; identifiers: string[] }> {
  // Never reconcile against an empty or partial universe — a caller passing a
  // department-scoped (or unloaded) registry would obsolete every other bank and
  // silently remove the LMS exam for those SOPs.
  if (activeFamilyKeys.size === 0) return { marked: 0, identifiers: [] };
  const orphan = [...mcqFamilies.values()].filter((f) => !activeFamilyKeys.has(f.famKey));
  return syncOrphanMcqBanks(orphan);
}

/** All non-obsolete MCQ bank family keys currently stored. */
export function activeMcqFamilyKeysFromAgg(mcqFamilies: Map<string, AggregatedMcqFamily>): Set<string> {
  return new Set(mcqFamilies.keys());
}

export { OBSOLETE_MCQ_REASON };
