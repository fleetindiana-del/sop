import crypto from "crypto";
import type { Types } from "mongoose";
import SOP, { type IMcqClauseCache, type ISOP } from "@/models/SOP";
import { parseClausesFromText, type SopClause } from "@/lib/mcq-clauses";
import { normalizeSopTextForMcq } from "@/lib/mcq-source-text";

export function hashSopContentForClauses(content: string): string {
  const normalized = normalizeSopTextForMcq(content);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export type ClauseIndexResult = {
  clauses: SopClause[];
  fromCache: boolean;
  contentHash: string;
};

/** Parse clauses and persist on the SOP (e.g. after upload or content re-extract). */
export async function buildAndSaveClauseIndex(
  sopId: Types.ObjectId | string,
  content: string,
): Promise<SopClause[]> {
  const clauses = parseClausesFromText(content);
  const contentHash = hashSopContentForClauses(content);
  const mcqClauseCache: IMcqClauseCache = {
    contentHash,
    clauses,
    parsedAt: new Date(),
  };
  // timestamps: false — this is an internal parse cache. Bumping updatedAt
  // would invalidate the grouped-registry signature and force a full SOP
  // collection scan on the next dashboard / LMS / matrix load.
  await SOP.updateOne({ _id: sopId }, { $set: { mcqClauseCache } }, { timestamps: false });
  return clauses;
}

/** Load cached clause index when content hash matches; otherwise parse and save. */
export async function getOrBuildClauseIndex(
  sop: Pick<ISOP, "_id" | "content"> & { mcqClauseCache?: IMcqClauseCache | null },
): Promise<ClauseIndexResult> {
  const content = sop.content ?? "";
  const contentHash = hashSopContentForClauses(content);
  const cached = sop.mcqClauseCache;

  if (
    cached?.contentHash === contentHash &&
    Array.isArray(cached.clauses) &&
    cached.clauses.length > 0
  ) {
    return { clauses: cached.clauses as SopClause[], fromCache: true, contentHash };
  }

  const clauses = await buildAndSaveClauseIndex(sop._id, content);
  return { clauses, fromCache: false, contentHash };
}
