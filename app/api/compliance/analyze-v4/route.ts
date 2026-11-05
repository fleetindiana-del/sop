import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { saveComplianceReport } from "@/lib/complianceReportStorage";
import { requireAuth } from "@/lib/withAuth";
import type { ComplianceFinding } from "@/lib/complianceEngine";
import { withActivityLog } from "@/lib/activity-log";

/**
 * SOP Compliance Intelligence Engine V4 - Batch Optimized (reference dev folder).
 * BATCH_SIZE clauses per AI call (~6 calls instead of 62 for typical audits).
 */

const BATCH_SIZE = 12;
const CLAUSE_TEXT_LIMIT = 400;

interface AnalysisConfig {
  aiModel?: "gemini-1.5-flash" | "gemini-1.5-pro" | "gemini-2.0-flash";
  maxClausesToAnalyze?: number;
  enableMissingDetection?: boolean;
  priorityThreshold?: number;
}

interface BatchFinding {
  guidelineId: string;
  guidelineName: string;
  folderName: string;
  pdfName: string;
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  complianceLevel: ComplianceFinding["complianceLevel"];
  matchConfidence: number;
  issueSeverity: ComplianceFinding["issueSeverity"];
  sopSectionAffected: string;
  mismatchExplanation: string;
  highlightedIssue: string;
  sopTextSnippet: string;
  guidelineRequirement: string;
  suggestedAction: string;
  suggestedText: string;
  estimatedEffort: ComplianceFinding["estimatedEffort"];
  priority: number;
  analyzedAt: Date;
  aiModelUsed: string;
}

function normLevel(raw: string): BatchFinding["complianceLevel"] {
  const v = String(raw || "").toLowerCase().replace(/_/g, "-");
  const valid: BatchFinding["complianceLevel"][] = [
    "compliant",
    "partial",
    "non-compliant",
    "not-applicable",
    "analysis-failed",
  ];
  return valid.includes(v as BatchFinding["complianceLevel"])
    ? (v as BatchFinding["complianceLevel"])
    : "non-compliant";
}

function calculateScore(findings: BatchFinding[]) {
  const totalChecks = findings.length;
  const compliantCount = findings.filter((f) => f.complianceLevel === "compliant").length;
  const partialCount = findings.filter((f) => f.complianceLevel === "partial").length;
  const nonCompliantCount = findings.filter((f) => f.complianceLevel === "non-compliant").length;
  const notApplicableCount = findings.filter((f) => f.complianceLevel === "not-applicable").length;

  const applicableChecks = totalChecks - notApplicableCount;
  const complianceScore =
    applicableChecks > 0 ? ((compliantCount * 10) + (partialCount * 5)) / applicableChecks : 10;

  const overallScore = Math.round(complianceScore * 10) / 10;

  return {
    overallScore,
    counts: { totalChecks, compliantCount, partialCount, nonCompliantCount, notApplicableCount },
  };
}

function buildBatchPrompt(
  sopData: { identifier: string; name: string; department: string; content?: string },
  items: Array<{ guideline: { name: string; folderName: string }; clause: { clauseNumber: string; clauseTitle: string; clauseText?: string } }>,
): string {
  const clauseList = items
    .map(
      ({ guideline, clause }, idx) =>
        `[${idx + 1}] Guideline: ${guideline.name} (${guideline.folderName})\n` +
        `    Clause ${clause.clauseNumber}: ${clause.clauseTitle}\n` +
        `    Requirement: ${(clause.clauseText || "").substring(0, 700)}${(clause.clauseText || "").length > 700 ? "..." : ""}`,
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
    'Respond with ONLY a valid JSON array. Each object must include: complianceLevel, matchConfidence, issueSeverity, sopSectionAffected, mismatchExplanation, sopTextSnippet, guidelineRequirement, suggestedAction, suggestedText, estimatedEffort, priority.'
  );
}

function parseBatchResponse(responseText: string, expectedCount: number): Record<string, unknown>[] {
  let text = responseText.trim();
  if (text.startsWith("```json")) text = text.slice(7);
  else if (text.startsWith("```")) text = text.slice(3);
  if (text.endsWith("```")) text = text.slice(0, -3);
  text = text.trim();

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("No JSON array in batch response");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Batch response is not an array");
  while (parsed.length < expectedCount) parsed.push(null);
  return parsed.slice(0, expectedCount);
}

export const maxDuration = 300;

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  const startTime = Date.now();

  try {
    await connectDB();

    const body = await request.json();
    const { sopId, guidelineIds, config = {} } = body;

    if (!sopId) {
      return NextResponse.json({ success: false, error: "sopId is required" }, { status: 400 });
    }

    const analysisConfig: AnalysisConfig = {
      aiModel: config.aiModel || "gemini-2.0-flash",
      maxClausesToAnalyze: config.maxClausesToAnalyze || 0,
      enableMissingDetection: config.enableMissingDetection !== false,
      priorityThreshold: config.priorityThreshold || 5,
    };

    const sop = await SOP.findById(sopId);
    if (!sop) return NextResponse.json({ success: false, error: "SOP not found" }, { status: 404 });

    const guidelineQuery =
      Array.isArray(guidelineIds) && guidelineIds.length > 0 ? { _id: { $in: guidelineIds } } : {};
    const guidelines = await SOPGuideline.find(guidelineQuery);
    if (guidelines.length === 0) {
      return NextResponse.json(
        { success: false, error: "No guidelines found. Please upload guidelines first." },
        { status: 400 },
      );
    }

    const allClauses: Array<{ guideline: (typeof guidelines)[0]; clause: { clauseNumber: string; clauseTitle: string; clauseText?: string } }> = [];
    for (const guideline of guidelines) {
      if (guideline.clauses?.length > 0) {
        for (const clause of guideline.clauses) {
          allClauses.push({ guideline, clause });
        }
      }
    }

    const clausesToAnalyze =
      analysisConfig.maxClausesToAnalyze && analysisConfig.maxClausesToAnalyze > 0
        ? allClauses.slice(0, analysisConfig.maxClausesToAnalyze)
        : allClauses;

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: analysisConfig.aiModel || "gemini-2.0-flash" });

    const findings: BatchFinding[] = [];
    const batches: typeof allClauses[] = [];
    for (let i = 0; i < clausesToAnalyze.length; i += BATCH_SIZE) {
      batches.push(clausesToAnalyze.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      try {
        const prompt = buildBatchPrompt(sop, batch);
        const result = await model.generateContent(prompt);
        const batchResults = parseBatchResponse(result.response.text(), batch.length);

        batch.forEach(({ guideline, clause }, i) => {
          const ai = batchResults[i];
          if (!ai || typeof ai !== "object") {
            findings.push({
              guidelineId: guideline._id.toString(),
              guidelineName: guideline.name,
              folderName: guideline.folderName,
              pdfName: guideline.pdfName,
              clauseNumber: clause.clauseNumber,
              clauseTitle: clause.clauseTitle,
              clauseText: clause.clauseText || "",
              complianceLevel: "analysis-failed",
              matchConfidence: 0,
              issueSeverity: "informational",
              sopSectionAffected: "N/A",
              mismatchExplanation: "Batch slot missing in AI response",
              highlightedIssue: "",
              sopTextSnippet: "",
              guidelineRequirement: clause.clauseText || "",
              suggestedAction: "Re-run analysis",
              suggestedText: "",
              estimatedEffort: "low",
              priority: 5,
              analyzedAt: new Date(),
              aiModelUsed: analysisConfig.aiModel!,
            });
            return;
          }
          findings.push({
            guidelineId: guideline._id.toString(),
            guidelineName: guideline.name,
            folderName: guideline.folderName,
            pdfName: guideline.pdfName,
            clauseNumber: clause.clauseNumber,
            clauseTitle: clause.clauseTitle,
            clauseText: clause.clauseText || "",
            complianceLevel: normLevel(String(ai.complianceLevel || "")),
            matchConfidence: Number(ai.matchConfidence) || 0,
            issueSeverity: (ai.issueSeverity as BatchFinding["issueSeverity"]) || "minor",
            sopSectionAffected: String(ai.sopSectionAffected || "N/A"),
            mismatchExplanation: String(ai.mismatchExplanation || ""),
            highlightedIssue: String(ai.highlightedIssue || ""),
            sopTextSnippet: String(ai.sopTextSnippet || ""),
            guidelineRequirement: String(ai.guidelineRequirement || clause.clauseText || ""),
            suggestedAction: String(ai.suggestedAction || ""),
            suggestedText: String(ai.suggestedText || ""),
            estimatedEffort: (ai.estimatedEffort as BatchFinding["estimatedEffort"]) || "medium",
            priority: Number(ai.priority) || 3,
            analyzedAt: new Date(),
            aiModelUsed: analysisConfig.aiModel!,
          });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        batch.forEach(({ guideline, clause }) => {
          findings.push({
            guidelineId: guideline._id.toString(),
            guidelineName: guideline.name,
            folderName: guideline.folderName,
            pdfName: guideline.pdfName,
            clauseNumber: clause.clauseNumber,
            clauseTitle: clause.clauseTitle,
            clauseText: clause.clauseText || "",
            complianceLevel: "analysis-failed",
            matchConfidence: 0,
            issueSeverity: "informational",
            sopSectionAffected: "N/A",
            mismatchExplanation: "Analysis failed due to AI error",
            highlightedIssue: msg,
            sopTextSnippet: "",
            guidelineRequirement: clause.clauseText || "",
            suggestedAction: "Re-run analysis",
            suggestedText: "",
            estimatedEffort: "low",
            priority: 5,
            analyzedAt: new Date(),
            aiModelUsed: analysisConfig.aiModel!,
          });
        });
      }

      if (batchIdx < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const scoreData = calculateScore(findings);
    let complianceStatus: string;
    if (scoreData.overallScore >= 9.0) complianceStatus = "Fully Compliant";
    else if (scoreData.overallScore >= 6.0) complianceStatus = "Partially Compliant";
    else complianceStatus = "Non-Compliant";

    const mappedFindings: (ComplianceFinding & { guidelineId?: string; folderName?: string })[] = findings.map(
      (f) => ({
        clauseNumber: f.clauseNumber,
        clauseTitle: f.clauseTitle,
        complianceLevel: f.complianceLevel,
        matchConfidence: f.matchConfidence,
        issueSeverity: f.issueSeverity,
        sopSectionAffected: f.sopSectionAffected,
        mismatchExplanation: f.mismatchExplanation,
        sopTextSnippet: f.sopTextSnippet,
        guidelineRequirement: f.guidelineRequirement,
        suggestedAction: f.suggestedAction,
        suggestedText: f.suggestedText,
        estimatedEffort: f.estimatedEffort,
        highlightedIssue: f.highlightedIssue,
        guidelineName: f.guidelineName,
        folderName: f.folderName,
        guidelineId: f.guidelineId,
      }),
    );

    const report = await saveComplianceReport({
      sopId: sop._id.toString(),
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      sopVersion: sop.version || "1.0",
      department: sop.department,
      findings: mappedFindings,
      overallScore: scoreData.overallScore,
      complianceStatus,
      analysisEngineVersion: "v4-batch",
      processingTimeMs: Date.now() - startTime,
    });

    return NextResponse.json({
      success: true,
      reportId: report._id,
      overallScore: scoreData.overallScore,
      complianceStatus,
      totalGuidelinesChecked: guidelines.length,
      totalClausesAnalyzed: clausesToAnalyze.length,
      batchesUsed: batches.length,
      findings: scoreData.counts,
      processingTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Analysis failed";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const POST = withActivityLog(handlePOST);
