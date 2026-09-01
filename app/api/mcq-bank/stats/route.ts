import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import User from "@/models/User";
import { requireAuth, filterByAssignedDepartments, isDeptScopedRole } from "@/lib/withAuth";
import { parseAssignedDepartments, departmentsMatch } from "@/lib/roles";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { sopFamilyGroupKey } from "@/lib/sop-utils";
import {
  MCQ_DEPARTMENT_ORDER,
  aggregateMcqBanksByFamily,
  buildActiveSopFamilyMap,
  findObsoleteMcqFamilies,
  guTranslatedProjection,
  mcqFamilyComplete,
} from "@/lib/mcq-bank-utils";
import { reconcileMcqBankObsoleteFlags } from "@/lib/mcq-bank-sync";

export async function GET() {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const mcqBankCol = db.collection("mcqbanks");

    // ── 1. Active SOP families — same source as the Main Dashboard ───────────
    const allGrouped = await getGroupedRegistryRows();
    const grouped = filterByAssignedDepartments(
      auth.session.user.role,
      auth.session.user.department,
      allGrouped,
    );
    const sopFamilyMap = buildActiveSopFamilyMap(grouped);
    // Obsolete reconciliation writes are GLOBAL, so they must be judged against the
    // whole registry. Using the caller's department-scoped view would mark every
    // other department's MCQ bank as an orphan (and hide Start Test in the LMS).
    const allSopFamilyMap = buildActiveSopFamilyMap(allGrouped);
    const preferredIdentifierByFam = new Map<string, string>();
    for (const row of allGrouped) {
      if (row.isObsolete) continue;
      const fam = sopFamilyGroupKey(row);
      if (!preferredIdentifierByFam.has(fam)) preferredIdentifierByFam.set(fam, row.identifier);
    }

    // ── 2. Aggregate MCQBank data (non-obsolete banks only) ───────────────────
    const bankAgg = await mcqBankCol.aggregate([
      { $match: { isObsolete: { $ne: true } } },
      {
        $project: {
          sopIdentifier: 1,
          sopName: 1,
          department: 1,
          language: 1,
          totalQuestions: { $size: { $ifNull: ["$mcqs", []] } },
          checkedCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isChecked", true] } },
            },
          },
          reviewedCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isReviewed", true] } },
            },
          },
          similarCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isSimilar", true] } },
            },
          },
          ...guTranslatedProjection,
          updatedAt: 1,
        },
      },
    ]).toArray();

    const obsoleteBankAgg = await mcqBankCol.aggregate([
      { $match: { isObsolete: true } },
      {
        $project: {
          sopIdentifier: 1,
          sopName: 1,
          department: 1,
          language: 1,
          totalQuestions: { $size: { $ifNull: ["$mcqs", []] } },
          checkedCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isChecked", true] } },
            },
          },
          reviewedCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isReviewed", true] } },
            },
          },
          similarCount: {
            $size: {
              $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isSimilar", true] } },
            },
          },
          ...guTranslatedProjection,
          updatedAt: 1,
        },
      },
    ]).toArray();

    const bankByIdentifier = aggregateMcqBanksByFamily(bankAgg as never[], preferredIdentifierByFam);
    const markedObsoleteFamilies = aggregateMcqBanksByFamily(obsoleteBankAgg as never[]);

    const orphanMcqFamilies = findObsoleteMcqFamilies(sopFamilyMap, bankByIdentifier);
    void reconcileMcqBankObsoleteFlags(new Set(allSopFamilyMap.keys()), bankByIdentifier);

    const obsoleteMcqFamilyMap = new Map<string, typeof orphanMcqFamilies[number]>();
    for (const fam of orphanMcqFamilies) obsoleteMcqFamilyMap.set(fam.famKey, fam);
    for (const [famKey, fam] of markedObsoleteFamilies) {
      if (!obsoleteMcqFamilyMap.has(famKey)) obsoleteMcqFamilyMap.set(famKey, fam);
    }
    const obsoleteMcqFamilies = [...obsoleteMcqFamilyMap.values()].sort((a, b) =>
      a.identifier.localeCompare(b.identifier),
    );

    // Active MCQ families only (must match an active SOP family)
    const activeMcqFamilies = [...bankByIdentifier.entries()]
      .filter(([famKey]) => sopFamilyMap.has(famKey));

    // ── 3. Trainer lookup ───────────────────────────────────────────────────
    const trainers = await User.find({ role: "trainer" }).select("name department").lean();
    const trainerByDept = new Map<string, string>();
    for (const t of trainers) {
      if (t.department && !trainerByDept.has(t.department)) trainerByDept.set(t.department, t.name);
    }

    // ── 4. Compute per-dept stats ───────────────────────────────────────────
    interface DeptAcc {
      identifiers: Set<string>;
      processAreas: Set<string>;
      totalSopEng: number; totalSopGuj: number;
      sopWithMcqs: number;
      approvedSops: number; partialSops: number; pendingSops: number; similarSops: number;
      totalQ: number; checkedQ: number; reviewedQ: number; similarQ: number;
      sopEng: number; sopGuj: number;
      remainingEng: number; remainingGuj: number;
    }
    const deptMap = new Map<string, DeptAcc>();

    const initAcc = (): DeptAcc => ({
      identifiers: new Set(), processAreas: new Set(),
      totalSopEng: 0, totalSopGuj: 0,
      sopWithMcqs: 0,
      approvedSops: 0, partialSops: 0, pendingSops: 0, similarSops: 0,
      totalQ: 0, checkedQ: 0, reviewedQ: 0, similarQ: 0,
      sopEng: 0, sopGuj: 0,
      remainingEng: 0, remainingGuj: 0,
    });

    for (const [famKey, sopData] of sopFamilyMap) {
      const dept = sopData.dept;
      if (!deptMap.has(dept)) deptMap.set(dept, initAcc());
      const d = deptMap.get(dept)!;
      d.identifiers.add(famKey);
      for (const pa of sopData.processAreas) d.processAreas.add(pa);
      if (sopData.languages.has("English")) d.totalSopEng++;
      if (sopData.languages.has("Gujarati")) d.totalSopGuj++;
    }

    for (const [famKey, bank] of activeMcqFamilies) {
      const dept = bank.dept;
      if (!deptMap.has(dept)) deptMap.set(dept, initAcc());
      const d = deptMap.get(dept)!;

      // A dual-language SOP only counts as "with MCQ" when BOTH its English and
      // Gujarati banks carry questions; a single-language SOP needs only its one
      // language. Partial coverage falls through to "without MCQ".
      const sop = sopFamilyMap.get(famKey);
      const complete = mcqFamilyComplete(
        {
          needsEn: sop?.languages.has("English") ?? false,
          needsGu: sop?.languages.has("Gujarati") ?? false,
        },
        bank,
      );
      if (complete) d.sopWithMcqs++;
      d.totalQ += bank.totalQ;
      d.checkedQ += bank.checkedQ;
      d.reviewedQ += bank.reviewedQ;
      d.similarQ += bank.similarQ;
      // "w/ EN" / "w/ GU" = families that actually HAVE that language's MCQs
      // (questions present), not merely an empty bank row. Mirrors the registry's
      // hasEnMcq/hasGuMcq and mcqFamilyComplete so the capsule and list agree.
      if (bank.enQ > 0) d.sopEng++;
      if (bank.guQ > 0) d.sopGuj++;

      if (bank.totalQ > 0 && bank.checkedQ >= bank.totalQ) {
        d.approvedSops++;
      } else if (bank.similarQ > 0) {
        d.similarSops++;
      } else if (bank.totalQ > 0 && bank.checkedQ > 0) {
        d.partialSops++;
      } else if (bank.totalQ > 0) {
        d.pendingSops++;
      }
    }

    for (const [, d] of deptMap) {
      d.remainingEng = Math.max(0, d.totalSopEng - d.sopEng);
      d.remainingGuj = Math.max(0, d.totalSopGuj - d.sopGuj);
    }

    const departments = MCQ_DEPARTMENT_ORDER.map((deptName) => {
      const d = deptMap.get(deptName) ?? initAcc();
      const sopCount = d.identifiers.size;
      return {
        department: deptName,
        sopCount,
        subcategories: d.processAreas.size || 1,
        totalQuestions: d.totalQ,
        checkedQuestions: d.checkedQ,
        reviewedQuestions: d.reviewedQ,
        similarQuestions: d.similarQ,
        remainingQuestions: Math.max(0, d.totalQ - d.checkedQ),
        mcqCoverage: d.totalQ > 0 ? Math.round((d.checkedQ / d.totalQ) * 100) : 0,
        withEnglish: d.sopEng,
        withGujarati: d.sopGuj,
        totalSopEng: d.totalSopEng,
        totalSopGuj: d.totalSopGuj,
        approvedSops: d.approvedSops,
        partialSops: d.partialSops,
        pendingSops: d.pendingSops,
        similarSops: d.similarSops,
        sopWithMcqs: d.sopWithMcqs,
        sopWithoutMcqs: Math.max(0, sopCount - d.sopWithMcqs),
        enRemaining: d.remainingEng,
        guRemaining: d.remainingGuj,
        trainer: trainerByDept.get(deptName) ?? null,
      };
    }).filter((d) => {
      if (!isDeptScopedRole(auth.session.user.role)) return true;
      const assigned = parseAssignedDepartments(auth.session.user.department);
      return assigned.some((a) => departmentsMatch(a, d.department));
    });

    const overall = departments.reduce(
      (acc, d) => {
        acc.totalUniqueSops += d.sopCount;
        acc.mcqFound += d.sopWithMcqs;
        acc.notFound += d.sopWithoutMcqs;
        acc.withEnglish += d.withEnglish;
        acc.withGujarati += d.withGujarati;
        acc.approvedSops += d.approvedSops;
        acc.partialSops += d.partialSops;
        acc.pendingSops += d.pendingSops;
        acc.similarSops += d.similarSops;
        acc.totalQuestions += d.totalQuestions;
        acc.checkedQuestions += d.checkedQuestions;
        acc.reviewedQuestions += d.reviewedQuestions;
        acc.similarQuestions += d.similarQuestions;
        acc.remainingQuestions += d.remainingQuestions;
        acc.enRemaining += d.enRemaining;
        acc.guRemaining += d.guRemaining;
        return acc;
      },
      {
        totalUniqueSops: 0,
        totalVersions: grouped.filter((r) => !r.isObsolete).length,
        totalMcqBanks: bankAgg.length,
        mcqFound: 0,
        notFound: 0,
        withEnglish: 0,
        withGujarati: 0,
        approvedSops: 0,
        partialSops: 0,
        pendingSops: 0,
        similarSops: 0,
        totalQuestions: 0,
        checkedQuestions: 0,
        reviewedQuestions: 0,
        similarQuestions: 0,
        remainingQuestions: 0,
        enRemaining: 0,
        guRemaining: 0,
      },
    );

    const obsoleteMcqs = {
      count: obsoleteMcqFamilies.length,
      identifiers: obsoleteMcqFamilies.map((f) => f.identifier),
      totalQuestions: obsoleteMcqFamilies.reduce((s, f) => s + f.totalQ, 0),
    };

    return NextResponse.json({ ...overall, departments, obsoleteMcqs });
  } catch (error) {
    console.error("[mcq-bank/stats] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch MCQ stats" },
      { status: 500 },
    );
  }
}
