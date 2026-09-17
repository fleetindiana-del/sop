import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import {
  maxVersionInGroup,
  recordsForVersion,
  sopFamilyGroupKey,
  sopFamilyIdentifierRegex,
  sopVersionFields,
} from "@/lib/sop-utils";
import type { ISOP } from "@/models/SOP";

export function groupRecordsByBase(records: ISOP[]) {
  const grouped = new Map<string, ISOP[]>();
  for (const record of records) {
    const key = sopFamilyGroupKey(record);
    const bucket = grouped.get(key) ?? [];
    bucket.push(record);
    grouped.set(key, bucket);
  }
  return grouped;
}

/**
 * Backfill version fields and strip contaminated file links from prior-version records.
 *
 * @param scopeIdentifiers When given, only the SOP families matching these identifiers
 * are scanned/reconciled instead of the entire collection — every per-upload call should
 * pass the identifiers that batch actually touched, so this stays cheap as the SOP
 * collection grows. Omit (full scan) only for an explicit whole-DB "fix everything" run.
 */
export async function reconcileSopVersions(scopeIdentifiers?: string[]) {
  await connectDB();
  const startedAt = Date.now();
  const filter = scopeIdentifiers?.length
    ? { $or: scopeIdentifiers.map((id) => ({ identifier: sopFamilyIdentifierRegex(id) })) }
    : {};
  // Exclude the heavy `content` field (full extracted SOP text — ~56MB across the collection).
  // Reconcile only needs identifier/version/sopDocuments; transferring `content` throttles a
  // free-tier (M0) cluster to minutes. `.lean()` returns plain objects, so writes go through a
  // single bulkWrite instead of one round-trip per record.
  const records = (await SOP.find(filter)
    .select("identifier version sopBaseId versionNum sopDocuments")
    .lean()) as unknown as ISOP[];
  const grouped = groupRecordsByBase(records);
  console.log(
    `[reconcile-versions] scanning ${records.length} record(s) in ${grouped.size} families ` +
      `(scope: ${scopeIdentifiers?.length ?? "all"})…`,
  );

  let cleaned = 0;
  const ops: Parameters<typeof SOP.bulkWrite>[0] = [];

  for (const [, family] of grouped) {
    const currentVersion = maxVersionInGroup(family);
    const currentIds = new Set(
      recordsForVersion(family, currentVersion).map((r) => r._id.toString()),
    );

    for (const record of family) {
      const fields = sopVersionFields(record.identifier, record.version);
      const isCurrent = currentIds.has(record._id.toString());
      const set: Record<string, unknown> = {};

      if (
        record.sopBaseId !== fields.sopBaseId ||
        record.versionNum !== fields.versionNum ||
        record.version !== fields.version
      ) {
        set.sopBaseId = fields.sopBaseId;
        set.versionNum = fields.versionNum;
        set.version = fields.version;
      }

      if (!isCurrent) {
        const docs = (record.sopDocuments ?? []).filter((doc) => {
          const type = doc.fileType?.toLowerCase();
          return type !== "docx" && type !== "pdf";
        });
        if (docs.length !== (record.sopDocuments ?? []).length) {
          set.sopDocuments = docs;
          cleaned++;
        }
      }

      if (Object.keys(set).length > 0) {
        ops.push({ updateOne: { filter: { _id: record._id }, update: { $set: set } } });
      }
    }
  }

  if (ops.length > 0) {
    await SOP.bulkWrite(ops, { ordered: false });
    invalidateDashboardSopsCache();
  }
  console.log(
    `[reconcile-versions] done: ${ops.length} updated, ${cleaned} cleaned in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return { updated: ops.length, cleaned, total: records.length };
}
