import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import User from "@/models/User";
import { requireAuth, forbidUnlessDepartmentAccess } from "@/lib/withAuth";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { sopFamilyGroupKey } from "@/lib/sop-utils";
import {
  aggregateMcqBanksByFamily,
  buildActiveSopFamilyMap,
  findObsoleteMcqFamilies,
  mcqFamilyComplete,
  mcqResolveDept,
} from "@/lib/mcq-bank-utils";

// GET /api/mcq-bank/dept-sops?dept=QA
//
// Source of truth is the Dashboard registry (getGroupedRegistryRows), NOT the
// mcqbanks collection. Every active SOP family in the department is listed —
// including families that have no MCQ bank for their current active version —
// so the modal mirrors the Dashboard SOP count exactly. MCQ counts are folded
// in per family (English + Gujarati combined), and each SOP carries a `hasMcq`
// flag so the client can split "with MCQs" vs "MCQ Not Found".
interface FamilyBank {
  totalQ: number;
  checkedQ: number;
  reviewedQ: number;
  similarQ: number;
  /** Per-language question totals — drive the dual-language completeness check. */
  enQ: number;
  guQ: number;
  lastUpdated: Date | null;
  banks: { id: string; language: string }[];
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const { searchParams } = new URL(request.url);
    const dept = searchParams.get("dept");
    if (!dept) return NextResponse.json({ error: "dept required" }, { status: 400 });

    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      dept,
    );
    if (denied) return denied;

    const mcqBankCol = db.collection("mcqbanks");

    // ── 1. Raw MCQ banks (non-obsolete) — counts only, no question content ──
    const allBanks = await mcqBankCol.aggregate([
      { $match: { isObsolete: { $ne: true } } },
      {
        $project: {
          _id: 1,
          sopIdentifier: 1,
          sopName: 1,
          department: 1,
          language: 1,
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
        },
      },
    ]).toArray() as {
      _id: unknown; sopIdentifier: string; sopName: string; department: string;
      language: string; updatedAt?: Date;
      totalQuestions: number; checkedCount: number; reviewedCount: number; similarCount: number;
    }[];

    // ── 2. Dashboard registry families (single source of truth) ──────────────
    const grouped = await getGroupedRegistryRows();
    const activeGrouped = grouped.filter((r) => !r.isObsolete);
    const activeFamilyMap = buildActiveSopFamilyMap(grouped);
    const mcqFamilies = aggregateMcqBanksByFamily(allBanks as never[]);
    // MCQ families whose SOP no longer exists in the Dashboard (wrong/old version).
    const orphanFamKeys = new Set(
      findObsoleteMcqFamilies(activeFamilyMap, mcqFamilies).map((f) => f.famKey),
    );

    // Fold banks per family key (English + Gujarati merged), dropping orphans so a
    // bank only counts when it matches the current active version of its SOP.
    const banksByFamily = new Map<string, FamilyBank>();
    for (const b of allBanks) {
      const fam = sopFamilyGroupKey({ identifier: (b.sopIdentifier ?? "").trim() });
      if (orphanFamKeys.has(fam)) continue;
      if (!banksByFamily.has(fam)) {
        banksByFamily.set(fam, {
          totalQ: 0, checkedQ: 0, reviewedQ: 0, similarQ: 0, enQ: 0, guQ: 0, lastUpdated: null, banks: [],
        });
      }
      const e = banksByFamily.get(fam)!;
      e.totalQ += b.totalQuestions;
      e.checkedQ += b.checkedCount;
      e.reviewedQ += b.reviewedCount;
      e.similarQ += b.similarCount;
      if ((b.language ?? "").toLowerCase() === "gujarati") e.guQ += b.totalQuestions;
      else e.enQ += b.totalQuestions;
      if (b._id) e.banks.push({ id: String(b._id), language: b.language ?? "English" });
      const ts = b.updatedAt ? new Date(b.updatedAt) : null;
      if (ts && (!e.lastUpdated || ts > e.lastUpdated)) e.lastUpdated = ts;
    }

    // Department families straight from the Dashboard registry.
    const deptRows = activeGrouped.filter(
      (r) => mcqResolveDept(r.identifier, r.department) === dept,
    );

    // ── 3. Per-SOP trainers (from the underlying SOP docs) ───────────────────
    const allRecordIds = [...new Set(deptRows.flatMap((r) => r.recordIds ?? []))];
    const [sopDocs, trainers] = await Promise.all([
      allRecordIds.length
        ? SOP.find({ _id: { $in: allRecordIds } })
            .select("_id assignedTrainers")
            .populate("assignedTrainers", "name")
            .lean()
        : [],
      User.find({ role: "trainer" }).select("name department").lean(),
    ]);

    const trainerByRecord = new Map<string, string[]>(
      (sopDocs as any[]).map((s) => [
        String(s._id),
        ((s.assignedTrainers ?? []) as any[]).map((t) => t.name).filter(Boolean),
      ]),
    );
    const trainerByDept = new Map<string, string>();
    for (const t of trainers) {
      if (t.department && !trainerByDept.has(t.department)) trainerByDept.set(t.department, t.name);
    }

    // ── 4. Build one entry per Dashboard SOP family ─────────────────────────
    const sopList = deptRows.map((row) => {
      const fam = sopFamilyGroupKey(row);
      const bank = banksByFamily.get(fam);
      // Dual-language (ENG-GUJ) SOPs need MCQs in BOTH languages to count as
      // "with MCQ"; single-language SOPs need only their one language.
      const hasMcq = mcqFamilyComplete(
        {
          needsEn: row.language === "ENG" || row.language === "ENG-GUJ",
          needsGu: row.language === "GUJ" || row.language === "ENG-GUJ",
        },
        bank,
      );

      const names = new Set<string>();
      for (const rid of row.recordIds ?? []) {
        for (const n of trainerByRecord.get(rid) ?? []) names.add(n);
      }
      const trainerName = names.size ? [...names].join(", ") : (trainerByDept.get(dept) ?? "");

      return {
        sopId: fam,
        sopCode: row.identifier,
        sopName: row.name,
        sopNameGujarati: row.nameGujarati ?? null,
        language: row.language,
        department: dept,
        trainerName,
        totalQuestions: bank?.totalQ ?? 0,
        checkedCount: bank?.checkedQ ?? 0,
        reviewedCount: bank?.reviewedQ ?? 0,
        similarCount: bank?.similarQ ?? 0,
        hasMcq,
        mcqBanks: bank?.banks ?? [],
        lastUpdated: bank?.lastUpdated?.toISOString() ?? null,
      };
    }).sort((a, b) => a.sopCode.localeCompare(b.sopCode));

    // ── 5. Department totals ─────────────────────────────────────────────────
    const withMcqs = sopList.filter((s) => s.hasMcq).length;
    const withoutMcqs = sopList.length - withMcqs;
    const totalQuestions = sopList.reduce((s, r) => s + r.totalQuestions, 0);
    const checkedCount = sopList.reduce((s, r) => s + r.checkedCount, 0);
    const reviewedCount = sopList.reduce((s, r) => s + r.reviewedCount, 0);
    const similarCount = sopList.reduce((s, r) => s + r.similarCount, 0);
    const notChecked = Math.max(0, totalQuestions - checkedCount);

    return NextResponse.json({
      success: true,
      dept,
      sops: sopList,
      total: sopList.length,
      withMcqs,
      withoutMcqs,
      stats: { totalQuestions, checkedCount, reviewedCount, similarCount, notChecked },
      trainer: trainerByDept.get(dept) ?? null,
    });
  } catch (error) {
    console.error("[dept-sops] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
