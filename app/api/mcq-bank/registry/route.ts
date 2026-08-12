import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth, filterByAssignedDepartments } from "@/lib/withAuth";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { sopFamilyGroupKey } from "@/lib/sop-utils";
import {
  deriveMcqAnnexureStatus,
  type McqAnnexureStatus,
} from "@/lib/mcqAnnexureStatus";
import {
  aggregateMcqBanksByFamily,
  buildActiveSopFamilyMap,
  findObsoleteMcqFamilies,
  mcqFamilyComplete,
  mcqResolveDept,
} from "@/lib/mcq-bank-utils";

export const dynamic = "force-dynamic";

type RawBank = {
  _id: unknown;
  sopIdentifier: string;
  sopName?: string;
  department?: string;
  language: string;
  isObsolete?: boolean;
  totalQuestions: number;
  checkedCount: number;
  reviewedCount: number;
  similarCount: number;
  easyCount: number;
  mediumCount: number;
  hardCount: number;
  updatedAt?: Date;
  annexureUsage?: {
    linkedCount?: number;
    includedCount?: number;
    skippedCount?: number;
    includedLabels?: string[];
  };
};

type RegistryEntry = {
  id: string;
  identifier: string;
  sopName: string;
  sopNameGujarati: string | null;
  department: string;
  language: string;
  langCode: string;
  totalMcqs: number;
  remaining: number;
  approved: number;
  partial: number;
  similar: number;
  easyCount: number;
  mediumCount: number;
  hardCount: number;
  lastUpdated: string | null;
  banks: { id: string; langCode: "ENG" | "GUJ" }[];
  /** True when the family has actual questions in every language it requires —
   *  the SAME "MCQ Found" criterion the dashboard capsule (stats route) uses. */
  hasMcq: boolean;
  /** Per-language MCQ presence — drives the capsule "w/ EN" / "w/ GU" filters so
   *  the list count matches the capsule (which counts families that HAVE that
   *  language's MCQs, not merely SOPs authored in that language). */
  hasEnMcq: boolean;
  hasGuMcq: boolean;
  enMcqCount: number;
  guMcqCount: number;
  isObsoleteMcq?: boolean;
  /** Count of annexure files linked to this SOP family — the MCQ generation
   *  pipeline folds their extracted text into the prompt when > 0. */
  annexureCount: number;
  /** Whether the family's current MCQs were actually generated from those
   *  annexures ("included"), or the annexures were linked after / could not be
   *  read ("linked-not-used"), or none are connected at all ("none"). */
  annexureStatus: McqAnnexureStatus;
  /** Annexure labels the generation run folded into the prompt. */
  annexureIncludedLabels: string[];
};

interface FamilyBank {
  totalQ: number;
  checkedQ: number;
  reviewedQ: number;
  similarQ: number;
  easyQ: number;
  mediumQ: number;
  hardQ: number;
  /** Per-language question totals — drive the dual-language completeness check. */
  enQ: number;
  guQ: number;
  lastUpdated: Date | null;
  banks: { id: string; langCode: "ENG" | "GUJ" }[];
  /** Highest annexure-included count any of the family's banks recorded at
   *  generation time — 0 means no bank was built from annexure text. */
  annexuresIncluded: number;
  annexureLabels: string[];
}

const bankProject = {
  sopIdentifier: 1,
  sopName: 1,
  department: 1,
  language: 1,
  isObsolete: 1,
  updatedAt: 1,
  totalQuestions: { $size: { $ifNull: ["$mcqs", []] } },
  checkedCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isChecked", true] } } },
  },
  reviewedCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isReviewed", true] } } },
  },
  similarCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isSimilar", true] } } },
  },
  easyCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Easy"] } } },
  },
  mediumCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Medium"] } } },
  },
  hardCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Hard"] } } },
  },
  annexureUsage: 1,
};

function foldBanks(rawBanks: RawBank[], includeFam: (fam: string, bank: RawBank) => boolean): Map<string, FamilyBank> {
  const banksByFamily = new Map<string, FamilyBank>();
  for (const b of rawBanks) {
    const fam = sopFamilyGroupKey({ identifier: (b.sopIdentifier ?? "").trim() });
    if (!includeFam(fam, b)) continue;
    if (!banksByFamily.has(fam)) {
      banksByFamily.set(fam, {
        totalQ: 0, checkedQ: 0, reviewedQ: 0, similarQ: 0,
        easyQ: 0, mediumQ: 0, hardQ: 0,
        enQ: 0, guQ: 0,
        lastUpdated: null, banks: [],
        annexuresIncluded: 0, annexureLabels: [],
      });
    }
    const e = banksByFamily.get(fam)!;
    e.totalQ += b.totalQuestions;
    e.checkedQ += b.checkedCount;
    e.reviewedQ += b.reviewedCount;
    e.similarQ += b.similarCount;
    e.easyQ += b.easyCount;
    e.mediumQ += b.mediumCount;
    e.hardQ += b.hardCount;
    const langCode: "ENG" | "GUJ" = (b.language ?? "").toLowerCase() === "gujarati" ? "GUJ" : "ENG";
    if (langCode === "GUJ") e.guQ += b.totalQuestions;
    else e.enQ += b.totalQuestions;
    if (b._id) e.banks.push({ id: String(b._id), langCode });
    const included = b.annexureUsage?.includedCount ?? 0;
    if (included > e.annexuresIncluded) e.annexuresIncluded = included;
    for (const label of b.annexureUsage?.includedLabels ?? []) {
      if (!e.annexureLabels.includes(label)) e.annexureLabels.push(label);
    }
    const ts = b.updatedAt ? new Date(b.updatedAt) : null;
    if (ts && (!e.lastUpdated || ts > e.lastUpdated)) e.lastUpdated = ts;
  }
  return banksByFamily;
}

function toEntry(
  id: string,
  identifier: string,
  sopName: string,
  sopNameGujarati: string | null,
  department: string,
  language: string,
  bank: FamilyBank | undefined,
  isObsoleteMcq?: boolean,
  annexureCount = 0,
): RegistryEntry {
  const langCode = language === "GUJ" ? "GUJ" : "ENG";
  // "MCQ Found" means real questions exist in every language the SOP requires —
  // identical to the dashboard capsule, so the list and capsule stay in sync.
  const hasMcq = mcqFamilyComplete(
    {
      needsEn: language === "ENG" || language === "ENG-GUJ",
      needsGu: language === "GUJ" || language === "ENG-GUJ",
    },
    bank,
  );
  return {
    id,
    identifier,
    sopName,
    sopNameGujarati,
    department,
    language,
    langCode,
    totalMcqs: bank?.totalQ ?? 0,
    remaining: bank ? Math.max(0, bank.totalQ - bank.checkedQ) : 0,
    approved: bank?.checkedQ ?? 0,
    partial: bank?.reviewedQ ?? 0,
    similar: bank?.similarQ ?? 0,
    easyCount: bank?.easyQ ?? 0,
    mediumCount: bank?.mediumQ ?? 0,
    hardCount: bank?.hardQ ?? 0,
    lastUpdated: bank?.lastUpdated?.toISOString() ?? null,
    banks: bank?.banks ?? [],
    hasMcq,
    hasEnMcq: (bank?.enQ ?? 0) > 0,
    hasGuMcq: (bank?.guQ ?? 0) > 0,
    enMcqCount: bank?.enQ ?? 0,
    guMcqCount: bank?.guQ ?? 0,
    isObsoleteMcq,
    annexureCount,
    // Live linked count vs. what generation recorded: annexures linked after the
    // MCQs were made (or unreadable ones) stay "linked-not-used" until regenerate.
    annexureStatus: deriveMcqAnnexureStatus({
      linkedCount: annexureCount,
      includedCount: bank?.annexuresIncluded ?? 0,
    }),
    annexureIncludedLabels: bank?.annexureLabels ?? [],
  };
}

async function buildFullRegistry() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database not connected");

  const grouped = await getGroupedRegistryRows();
  const activeGrouped = grouped.filter((r) => !r.isObsolete);
  const activeFamilyMap = buildActiveSopFamilyMap(grouped);
  const mcqBankCol = db.collection("mcqbanks");

  const [activeBankRows, obsoleteMarkedRows, allBankRows] = await Promise.all([
    mcqBankCol.aggregate([{ $match: { isObsolete: { $ne: true } } }, { $project: bankProject }]).toArray() as Promise<RawBank[]>,
    mcqBankCol.aggregate([{ $match: { isObsolete: true } }, { $project: bankProject }]).toArray() as Promise<RawBank[]>,
    mcqBankCol.aggregate([{ $project: bankProject }]).toArray() as Promise<RawBank[]>,
  ]);

  const activeMcqFamilies = aggregateMcqBanksByFamily(activeBankRows);
  const orphanFamilies = findObsoleteMcqFamilies(activeFamilyMap, activeMcqFamilies);
  const orphanFamKeys = new Set(orphanFamilies.map((f) => f.famKey));
  const markedObsoleteFamilies = aggregateMcqBanksByFamily(obsoleteMarkedRows);

  const obsoleteMcqFamilies = [...new Map([
    ...orphanFamilies.map((f) => [f.famKey, f] as const),
    ...[...markedObsoleteFamilies.values()].map((f) => [f.famKey, f] as const),
  ]).values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
  const obsoleteFamKeys = new Set(obsoleteMcqFamilies.map((f) => f.famKey));

  const activeBanksByFamily = foldBanks(
    activeBankRows,
    (fam, b) => !b.isObsolete && !orphanFamKeys.has(fam),
  );
  const obsoleteBanksByFamily = foldBanks(
    allBankRows,
    (fam, b) => obsoleteFamKeys.has(fam) || Boolean(b.isObsolete),
  );

  const active: RegistryEntry[] = activeGrouped.map((row) => {
    const fam = sopFamilyGroupKey(row);
    const bank = activeBanksByFamily.get(fam);
    return toEntry(
      fam,
      row.identifier,
      row.name,
      row.nameGujarati ?? null,
      mcqResolveDept(row.identifier, row.department),
      row.language,
      bank,
      undefined,
      row.annexures?.length ?? 0,
    );
  });

  const obsolete: RegistryEntry[] = obsoleteMcqFamilies.map((fam) => {
    const bank = obsoleteBanksByFamily.get(fam.famKey);
    const langs: string[] = [];
    if (fam.hasEn) langs.push("ENG");
    if (fam.hasGu) langs.push("GUJ");
    const language = langs.length === 2 ? "ENG-GUJ" : langs[0] ?? "ENG";
    return toEntry(
      fam.famKey,
      fam.identifier,
      fam.sopName,
      null,
      fam.dept,
      language,
      bank ?? {
        totalQ: fam.totalQ,
        checkedQ: fam.checkedQ,
        reviewedQ: fam.reviewedQ,
        similarQ: fam.similarQ,
        easyQ: 0,
        mediumQ: 0,
        hardQ: 0,
        enQ: fam.enQ,
        guQ: fam.guQ,
        lastUpdated: fam.lastUpdated,
        banks: fam.banks,
        annexuresIncluded: 0,
        annexureLabels: [],
      },
      true,
    );
  });

  return { active, obsolete };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all") === "1";

    if (all) {
      const { active, obsolete } = await buildFullRegistry();
      return NextResponse.json({
        active: filterByAssignedDepartments(
          auth.session.user.role,
          auth.session.user.department,
          active,
        ),
        obsolete: filterByAssignedDepartments(
          auth.session.user.role,
          auth.session.user.department,
          obsolete,
        ),
      });
    }

    // Legacy paginated path — kept for compatibility; prefer all=1 from the client.
    const { active, obsolete } = await buildFullRegistry();
    const obsoleteOnly = searchParams.get("obsoleteOnly") === "true";
    let entries = obsoleteOnly ? obsolete : active;
    entries = filterByAssignedDepartments(
      auth.session.user.role,
      auth.session.user.department,
      entries,
    );
    const total = entries.length;
    return NextResponse.json({ items: entries, total, page: 1, limit: total, obsoleteOnly });
  } catch (error) {
    console.error("[mcq-bank/registry] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch registry" },
      { status: 500 },
    );
  }
}
