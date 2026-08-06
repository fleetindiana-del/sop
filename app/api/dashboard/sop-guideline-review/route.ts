import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import SOP from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import SOPGuidelineResult from "@/models/SOPGuidelineResult";
import ComplianceReport from "@/models/ComplianceReport";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH_SIZE = 12;
const SMALL_BATCH_SIZE = 5;
const CLAUSE_TEXT_LIMIT = 400;

function isLikelyObjectId(id: string): boolean {
  return typeof id === "string" && /^[a-f\d]{24}$/i.test(id);
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normLevel(raw: string): string {
  const v = String(raw || "")
    .toLowerCase()
    .replace(/_/g, "-");
  const valid = ["compliant", "partial", "non-compliant", "not-applicable"];
  return valid.includes(v) ? v : "non-compliant";
}

function buildBatchPrompt(
  sopData: { identifier: string; name: string; department: string; content: string },
  items: Array<{
    guideline: { name: string; folderName: string };
    clause: { clauseNumber: string; clauseTitle: string; clauseText: string };
  }>,
): string {
  const clauseList = items
    .map(
      ({ guideline, clause }, idx) =>
        `[${idx + 1}] Guideline: ${guideline.name} (${guideline.folderName})\n` +
        `    Clause ${clause.clauseNumber}: ${clause.clauseTitle}\n` +
        `    Requirement: ${(clause.clauseText || "").substring(0, CLAUSE_TEXT_LIMIT)}` +
        ((clause.clauseText || "").length > CLAUSE_TEXT_LIMIT ? "..." : ""),
    )
    .join("\n\n");

  const sopContent = (sopData.content || "No content available").substring(0, 14000);
  const truncated = (sopData.content || "").length > 14000;

  return (
    "You are a pharmaceutical GMP compliance expert.\n\n" +
    "Analyze the SOP below against EACH numbered guideline clause.\n" +
    `Return a JSON ARRAY containing exactly ${items.length} objects (one per clause, same order).\n\n` +
    "**SOP:**\n" +
    `- Identifier: ${sopData.identifier}\n` +
    `- Name: ${sopData.name}\n` +
    `- Department: ${sopData.department}\n\n` +
    "**SOP CONTENT:**\n" +
    sopContent +
    (truncated ? "\n\n... (content truncated)" : "") +
    "\n\n" +
    `**CLAUSES TO CHECK (${items.length} total):**\n` +
    clauseList +
    "\n\n" +
    "**REQUIRED JSON SHAPE per object:**\n" +
    "{\n" +
    '  "complianceLevel": "compliant" | "partial" | "non-compliant" | "not-applicable",\n' +
    '  "matchConfidence": 0-100,\n' +
    '  "issueType": "missing-clause" | "partial-coverage" | "incorrect-implementation" | "no-issue" | "not-applicable",\n' +
    '  "issueSeverity": "critical" | "major" | "minor" | "informational",\n' +
    '  "sopSectionAffected": "Section X.Y - Title or N/A",\n' +
    '  "mismatchExplanation": "Concise explanation of gap or compliance",\n' +
    '  "highlightedIssue": "Specific issue or empty string",\n' +
    '  "sopTextSnippet": "Relevant verbatim SOP text (max 200 chars) or empty",\n' +
    '  "guidelineRequirement": "What this clause requires (concise)",\n' +
    '  "suggestedAction": "Specific actionable fix",\n' +
    '  "suggestedText": "Exact proposed text to add/modify",\n' +
    '  "estimatedEffort": "low" | "medium" | "high",\n' +
    '  "priority": 1-5\n' +
    "}\n\n" +
    "RULES:\n" +
    '1. SOP does not mention topic → "non-compliant" + "missing-clause"\n' +
    '2. SOP partially addresses → "partial" + "partial-coverage"\n' +
    '3. SOP fully complies → "compliant" + "no-issue"\n' +
    '4. Clause irrelevant to this SOP → "not-applicable"\n' +
    "5. Be specific and actionable.\n\n" +
    `Respond with ONLY a valid JSON array of length ${items.length}. No markdown, no extra text.`
  );
}

function parseBatchResponse(text: string, expectedCount: number): unknown[] {
  let t = text.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  t = t.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("No JSON array in batch response");
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Response is not array");
  while (parsed.length < expectedCount) parsed.push(null);
  return parsed.slice(0, expectedCount);
}

function failedFinding(guideline: Record<string, unknown>, clause: Record<string, unknown>) {
  return {
    guidelineId: (guideline._id as { toString?: () => string })?.toString?.() ?? "",
    guidelineName: guideline.name,
    folderName: guideline.folderName,
    pdfName: guideline.pdfName || "",
    clauseNumber: clause.clauseNumber,
    clauseTitle: clause.clauseTitle,
    clauseText: clause.clauseText,
    complianceLevel: "non-compliant",
    matchConfidence: 0,
    issueType: "missing-clause",
    issueSeverity: "informational",
    sopSectionAffected: "N/A",
    mismatchExplanation: "Analysis failed — could not evaluate this clause. Please re-run.",
    highlightedIssue: "",
    sopTextSnippet: "",
    guidelineRequirement: clause.clauseTitle || clause.clauseNumber || "Unknown clause",
    suggestedAction: "Re-run analysis",
    suggestedText: "",
    estimatedEffort: "low",
    priority: 5,
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const sopId = typeof body.sopId === "string" ? body.sopId.trim() : "";
    const sopIdentifier = typeof body.sopIdentifier === "string" ? body.sopIdentifier.trim() : "";
    const sopNo = typeof body.sopNo === "string" ? body.sopNo.trim() : "";
    const rawIds = body.guidelineIds;
    const guidelineIds: string[] = Array.isArray(rawIds)
      ? rawIds.map((x: unknown) => String(x).trim()).filter(isLikelyObjectId)
      : [];

    if (!sopId && !sopIdentifier && !sopNo) {
      return NextResponse.json(
        { success: false, error: "sopId, sopIdentifier, or sopNo is required" },
        { status: 400 },
      );
    }
    if (guidelineIds.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No guidelines selected",
          userMessage:
            "Choose at least one guideline document from your stored library to run the check.",
        },
        { status: 400 },
      );
    }

    await connectDB();

    let sop: { _id?: unknown; identifier?: string; name?: string; department?: string; content?: string } | null = null;
    if (sopId && isLikelyObjectId(sopId)) sop = await SOP.findById(sopId).lean();
    if (!sop && sopIdentifier) {
      sop = await SOP.findOne({
        identifier: new RegExp("^" + escapeRegex(sopIdentifier) + "$", "i"),
      }).lean();
    }
    if (!sop && sopNo) {
      sop = await SOP.findOne({
        identifier: new RegExp("^" + escapeRegex(sopNo) + "$", "i"),
      }).lean();
    }
    if (!sop && sopNo) {
      const loose = sopNo.replace(/[-\s]/g, "").toUpperCase();
      const candidates = await SOP.find({
        identifier: { $regex: new RegExp(loose.substring(0, Math.min(loose.length, 8)), "i") },
      })
        .select("_id identifier content name department")
        .lean();
      const match = candidates.find(
        (c) => (c.identifier || "").replace(/[-\s]/g, "").toUpperCase() === loose,
      );
      if (match) sop = await SOP.findById(match._id).lean();
    }

    if (!sop) {
      return NextResponse.json(
        {
          success: false,
          error: "SOP not found",
          userMessage: `Could not find SOP "${sopNo || sopIdentifier || sopId}" in the database.`,
        },
        { status: 404 },
      );
    }

    const content = String(sop.content || "").trim();
    if (content.length < 80) {
      return NextResponse.json(
        {
          success: false,
          error: "SOP has insufficient text",
          userMessage: "This SOP has little or no extracted text. Re-upload or OCR the document first.",
        },
        { status: 400 },
      );
    }

    const objectIds = guidelineIds.map((id) => new mongoose.Types.ObjectId(id));
    const guidelines = await SOPGuideline.find({
      _id: { $in: objectIds },
      ocrStatus: "completed",
    })
      .select("name folderName pdfName guidelineType category clauses")
      .lean();

    if (guidelines.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No matching guidelines",
          userMessage:
            "None of the selected guidelines are available or finished processing (OCR).",
        },
        { status: 400 },
      );
    }

    const allClauses: Array<{ guideline: Record<string, unknown>; clause: Record<string, unknown> }> =
      [];
    for (const g of guidelines) {
      const clauses = Array.isArray(g.clauses) ? g.clauses : [];
      for (const c of clauses) {
        allClauses.push({
          guideline: g as unknown as Record<string, unknown>,
          clause: c as unknown as Record<string, unknown>,
        });
      }
    }

    if (allClauses.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No clauses found",
          userMessage: "The selected guideline documents have no clause structure.",
        },
        { status: 400 },
      );
    }

    const geminiKey =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_AI_API_KEY ||
      process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
      "";
    if (!geminiKey) {
      return NextResponse.json(
        {
          success: false,
          error: "AI not configured",
          userMessage: "Set GEMINI_API_KEY in the environment to run guideline review.",
        },
        { status: 503 },
      );
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const findings: Record<string, unknown>[] = [];
    const batches: Array<typeof allClauses> = [];
    for (let i = 0; i < allClauses.length; i += BATCH_SIZE) {
      batches.push(allClauses.slice(i, i + BATCH_SIZE));
    }

    const sopData = {
      identifier: String(sop.identifier),
      name: String(sop.name),
      department: String(sop.department || "General"),
      content,
    };

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];
      const avgClauseLen =
        batch.reduce((acc, { clause }) => acc + String(clause.clauseText || "").length, 0) /
        batch.length;
      const effectiveBatchSize = avgClauseLen > 300 ? SMALL_BATCH_SIZE : BATCH_SIZE;

      const subBatches: Array<typeof batch> = [];
      for (let j = 0; j < batch.length; j += effectiveBatchSize) {
        subBatches.push(batch.slice(j, j + effectiveBatchSize));
      }

      for (const subBatch of subBatches) {
        let batchResult: unknown[] | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const prompt = buildBatchPrompt(sopData, subBatch as Parameters<typeof buildBatchPrompt>[1]);
            const result = await model.generateContent(prompt);
            batchResult = parseBatchResponse(result.response.text(), subBatch.length);
            break;
          } catch (batchErr) {
            console.error(`[sop-guideline-review] batch error (attempt ${attempt + 1}):`, batchErr);
            if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
          }
        }

        subBatch.forEach(({ guideline, clause }, i) => {
          const ai = batchResult?.[i] as Record<string, unknown> | null;
          if (!ai || typeof ai !== "object") {
            findings.push(failedFinding(guideline, clause));
            return;
          }
          findings.push({
            guidelineId: (guideline._id as { toString?: () => string })?.toString?.() ?? "",
            guidelineName: guideline.name,
            folderName: guideline.folderName,
            pdfName: guideline.pdfName || "",
            clauseNumber: clause.clauseNumber,
            clauseTitle: clause.clauseTitle,
            clauseText: clause.clauseText,
            complianceLevel: normLevel(String(ai.complianceLevel || "")),
            matchConfidence: Number(ai.matchConfidence) || 0,
            issueType: ai.issueType || "not-applicable",
            issueSeverity: ai.issueSeverity || "minor",
            sopSectionAffected: String(ai.sopSectionAffected || "N/A"),
            mismatchExplanation: String(ai.mismatchExplanation || ""),
            highlightedIssue: String(ai.highlightedIssue || ""),
            sopTextSnippet: String(ai.sopTextSnippet || ""),
            guidelineRequirement: String(ai.guidelineRequirement || clause.clauseTitle || ""),
            suggestedAction: String(ai.suggestedAction || ""),
            suggestedText: String(ai.suggestedText || ""),
            estimatedEffort: ai.estimatedEffort || "medium",
            priority: Number(ai.priority) || 3,
          });
        });
        if (subBatches.indexOf(subBatch) < subBatches.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      if (bIdx < batches.length - 1) await new Promise((r) => setTimeout(r, 300));
    }

    const compliantCount = findings.filter((f) => f.complianceLevel === "compliant").length;
    const partialCount = findings.filter((f) => f.complianceLevel === "partial").length;
    const nonCompliantCount = findings.filter((f) => f.complianceLevel === "non-compliant").length;
    const notApplicable = findings.filter((f) => f.complianceLevel === "not-applicable").length;
    const applicable = findings.length - notApplicable;
    const overallScore =
      applicable > 0
        ? Math.round(((compliantCount * 10 + partialCount * 5) / applicable) * 10) / 10
        : 10;

    try {
      await SOPGuidelineResult.findOneAndUpdate(
        { sopNo: String(sop.identifier) },
        {
          sopId: sop._id,
          sopNo: sop.identifier,
          sopName: sop.name,
          overallScore,
          clausesAnalyzed: findings.length,
          guidelineDocumentsUsed: guidelines.length,
          guidelineIds,
          runAt: new Date(),
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    } catch (saveErr) {
      console.warn("sop-guideline-review: could not persist result:", saveErr);
    }

    return NextResponse.json({
      success: true,
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      guidelineDocumentsUsed: guidelines.length,
      guidelineIdsRequested: guidelineIds.length,
      clausesAnalyzed: findings.length,
      batchesUsed: batches.length,
      overallScore,
      counts: { compliantCount, partialCount, nonCompliantCount, notApplicable },
      findings,
    });
  } catch (e) {
    console.error("sop-guideline-review:", e);
    return NextResponse.json(
      {
        success: false,
        error: (e as Error).message || "Review failed",
        userMessage: "Guideline review failed. Try again or check server logs.",
      },
      { status: 500 },
    );
  }
}

function normalizeComplianceFindings(findings: unknown[]) {
  return (findings as Record<string, unknown>[]).map((f) => ({
    guidelineId: (f.guidelineId as { toString?: () => string })?.toString?.() ?? "",
    guidelineName: f.guidelineName || "",
    folderName: f.folderName || "",
    pdfName: f.pdfName || "",
    clauseNumber: f.clauseNumber || "",
    clauseTitle: f.clauseTitle || "",
    clauseText: f.clauseText || "",
    complianceLevel: f.complianceLevel || "not-applicable",
    matchConfidence: f.matchConfidence ?? 0,
    issueType: f.issueType || "not-applicable",
    issueSeverity: f.issueSeverity || "informational",
    sopSectionAffected: f.sopSectionAffected || f.sopSectionNumber || "N/A",
    mismatchExplanation: f.mismatchExplanation || f.specificGap || "",
    highlightedIssue: f.highlightedIssue || "",
    sopTextSnippet: f.sopTextSnippet || "",
    guidelineRequirement: f.guidelineRequirement || f.clauseTitle || "",
    suggestedAction: f.suggestedAction || "",
    suggestedText: f.suggestedText || "",
    estimatedEffort: f.estimatedEffort || "medium",
    priority: f.priority ?? 3,
  }));
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const listAll = searchParams.get("listAll") === "true";
    const sopNo = searchParams.get("sopNo")?.trim();

    if (listAll) {
      const wizardResults = await SOPGuidelineResult.find({})
        .select(
          "sopNo sopName overallScore clausesAnalyzed guidelineDocumentsUsed guidelineIds runAt",
        )
        .sort({ runAt: -1 })
        .lean();

      const cache: Record<string, Record<string, unknown>> = {};
      for (const r of wizardResults) {
        cache[r.sopNo] = {
          sopNo: r.sopNo,
          sopName: r.sopName || "",
          overallScore: r.overallScore ?? 0,
          clausesAnalyzed: r.clausesAnalyzed ?? 0,
          guidelineDocumentsUsed: r.guidelineDocumentsUsed ?? 0,
          guidelineIds: Array.isArray(r.guidelineIds) ? r.guidelineIds : [],
          runAt: r.runAt,
          findings: [],
          source: "dashboard-wizard",
        };
      }

      try {
        const complianceReports = await ComplianceReport.find({ analysisStatus: "completed" })
          .select(
            "sopIdentifier sopName overallScore scoreBreakdown totalGuidelinesChecked findings analysisCompletedAt",
          )
          .sort({ analysisCompletedAt: -1 })
          .limit(500)
          .batchSize(1000)
          .allowDiskUse(true)
          .lean();

        for (const r of complianceReports) {
          const key = r.sopIdentifier;
          if (!key) continue;

          const normalizedFindings = normalizeComplianceFindings(r.findings || []);

          if (!cache[key]) {
            cache[key] = {
              sopNo: key,
              sopName: r.sopName || "",
              overallScore: r.overallScore ?? 0,
              clausesAnalyzed:
                r.scoreBreakdown?.totalApplicableRequirements ?? normalizedFindings.length,
              guidelineDocumentsUsed: r.totalGuidelinesChecked ?? 0,
              runAt: r.analysisCompletedAt || new Date(),
              findings: normalizedFindings,
              source: "compliance-section",
            };
          } else if (
            Array.isArray(cache[key].findings) &&
            (cache[key].findings as unknown[]).length === 0 &&
            normalizedFindings.length > 0
          ) {
            cache[key].findings = normalizedFindings;
            cache[key].overallScore = cache[key].overallScore || (r.overallScore ?? 0);
            cache[key].clausesAnalyzed =
              cache[key].clausesAnalyzed ||
              (r.scoreBreakdown?.totalApplicableRequirements ?? normalizedFindings.length);
            cache[key].guidelineDocumentsUsed =
              cache[key].guidelineDocumentsUsed || (r.totalGuidelinesChecked ?? 0);
          }
        }
      } catch (compErr) {
        console.warn("sop-guideline-review GET: could not load ComplianceReport:", compErr);
      }

      return NextResponse.json({ success: true, results: Object.values(cache) });
    }

    if (sopNo) {
      const wizardResult = await SOPGuidelineResult.findOne({ sopNo }).lean();

      let complianceFindings: Record<string, unknown>[] = [];
      let complianceReport: {
        sopIdentifier?: string;
        sopName?: string;
        overallScore?: number;
        scoreBreakdown?: { totalApplicableRequirements?: number };
        totalGuidelinesChecked?: number;
        analysisCompletedAt?: Date;
        findings?: unknown[];
      } | null = null;
      try {
        complianceReport = await ComplianceReport.findOne({
          sopIdentifier: sopNo,
          analysisStatus: "completed",
        })
          .sort({ analysisCompletedAt: -1 })
          .allowDiskUse(true)
          .lean();
        if (complianceReport) {
          complianceFindings = normalizeComplianceFindings(complianceReport.findings || []);
        }
      } catch {
        /* ignore */
      }

      if (wizardResult) {
        const findings = complianceFindings.length > 0 ? complianceFindings : [];
        return NextResponse.json({
          success: true,
          source: "dashboard-wizard",
          result: { ...wizardResult, findings },
        });
      }

      if (complianceReport) {
        return NextResponse.json({
          success: true,
          source: "compliance-section",
          result: {
            sopNo: complianceReport.sopIdentifier,
            sopName: complianceReport.sopName || "",
            overallScore: complianceReport.overallScore ?? 0,
            clausesAnalyzed:
              complianceReport.scoreBreakdown?.totalApplicableRequirements ??
              complianceFindings.length,
            guidelineDocumentsUsed: complianceReport.totalGuidelinesChecked ?? 0,
            runAt: complianceReport.analysisCompletedAt || new Date(),
            findings: complianceFindings,
          },
        });
      }

      return NextResponse.json(
        { success: false, error: "No stored result for this SOP" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { success: false, error: "Provide listAll=true or sopNo param" },
      { status: 400 },
    );
  } catch (e) {
    console.error("sop-guideline-review GET:", e);
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}
