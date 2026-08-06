import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import { type SopLibraryEntry } from "@/lib/complianceEngineV5";
import { runComplianceReview } from "@/lib/compliance-review-orchestrator";
import { resolveComplianceSopContent } from "@/lib/compliance-sop-content";
import { extractClauses } from "@/lib/ocrProcessor";
import { requireAuth } from "@/lib/withAuth";
import { getComplianceProvider, checkClaudeCliHealth, checkCodexCliHealth, type LlmProvider } from "@/lib/llm";
import { warmupOllamaComplianceModel } from "@/lib/ollama-warmup";
import {
  beginComplianceRun,
  endComplianceRun,
  isComplianceAnalysisCancelledError,
  isComplianceRunActiveInProcess,
} from "@/lib/compliance-run-control";

const MAX_CLAUSE_TEXT = 4000;

type StoredClause = { clauseNumber?: string; clauseTitle?: string; clauseText?: string };

/**
 * Guidelines uploaded before clause extraction was fixed often contain a single
 * fallback clause ("1") covering the whole document. Detect that case so we can
 * re-split from rawText and analyse EVERY clause instead of one truncated blob.
 */
function clausesLookUnsplit(stored: StoredClause[] | undefined): boolean {
  if (!stored || stored.length === 0) return true;
  if (stored.length === 1) return true;
  const realNumbers = stored.filter((c) => c.clauseNumber && c.clauseNumber !== "1").length;
  return realNumbers === 0;
}

function resolveClauses(g: {
  name: string;
  clauses?: StoredClause[];
  rawText?: string;
}): StoredClause[] {
  const stored = g.clauses ?? [];
  if (clausesLookUnsplit(stored) && g.rawText && g.rawText.trim().length > 500) {
    const re = extractClauses(g.rawText, g.name);
    if (re.length > stored.length) {
      return re.map((c) => ({
        clauseNumber: c.clauseNumber,
        clauseTitle: c.clauseTitle,
        clauseText: c.clauseText,
      }));
    }
  }
  return stored;
}

// Vercel Hobby caps serverless maxDuration at 300s. Longer audits should run on Pro
// or be split across incremental/recheck routes.
export const maxDuration = 300;

/**
 * V5 — Structured regulatory compliance audit.
 * Same caching behaviour as V4 but runs the auditor-grade pipeline:
 * evidence matching, GMP intelligence, cross-SOP dependency validation,
 * de-duplication, risk classification, transparent scoring and traceability.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { sopId, guidelineId, guidelineIds: bodyGuidelineIds, forceRefresh = false, mode } = body;
    const p = body.provider as string | undefined;
    const providerOverride: LlmProvider | undefined =
      p === "claude" ? "claude" : p === "codex" ? "codex" : p === "ollama" ? "ollama" : p === "gemini" ? "gemini" : undefined;
    const modelOverride: string | undefined =
      typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;

    if (!sopId) {
      return NextResponse.json({ success: false, error: "sopId is required" }, { status: 400 });
    }

    const sopRow = await SOP.findById(sopId).lean();
    if (!sopRow) return NextResponse.json({ success: false, error: "SOP not found" }, { status: 404 });

    const resolved = await resolveComplianceSopContent(sopId, {
      includeAnnexures: body.includeAnnexures !== false,
    });
    if (!resolved) {
      return NextResponse.json(
        {
          success: false,
          error: `SOP "${sopRow.identifier}" has no parseable content. Upload a DOCX version or re-link from storage so text can be extracted.`,
        },
        { status: 422 },
      );
    }

    const sop = { ...resolved.record, content: resolved.content };
    if (resolved.referencedSupplementChars > 0) {
      console.log(
        `[analyze-v5] ${sop.identifier}: merged ${resolved.referencedSupplementChars} chars from referenced SOPs`,
      );
    }
    if (resolved.annexureSupplementChars > 0) {
      console.log(
        `[analyze-v5] ${sop.identifier}: merged ${resolved.annexureSupplementChars} chars from linked annexures`,
      );
    }

    const resolvedGuidelineIds: string[] = [];
    if (Array.isArray(bodyGuidelineIds)) {
      for (const id of bodyGuidelineIds) {
        const trimmed = String(id).trim();
        if (trimmed && mongoose.Types.ObjectId.isValid(trimmed) && !resolvedGuidelineIds.includes(trimmed)) {
          resolvedGuidelineIds.push(trimmed);
        }
      }
    }
    const trimmedGuidelineId = typeof guidelineId === "string" ? guidelineId.trim() : "";
    if (
      trimmedGuidelineId &&
      mongoose.Types.ObjectId.isValid(trimmedGuidelineId) &&
      !resolvedGuidelineIds.includes(trimmedGuidelineId)
    ) {
      resolvedGuidelineIds.push(trimmedGuidelineId);
    }

    const guidelineQuery: { ocrStatus: "completed"; _id?: { $in: mongoose.Types.ObjectId[] } } = {
      ocrStatus: "completed",
    };
    if (resolvedGuidelineIds.length) {
      guidelineQuery._id = {
        $in: resolvedGuidelineIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    const guidelines = await SOPGuideline.find(guidelineQuery)
      .select("name folderName pdfName rawText clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
      .lean();
    if (!guidelines.length) {
      return NextResponse.json(
        {
          success: false,
          error: resolvedGuidelineIds.length
            ? "One or more selected guidelines were not found or are not ready. Upload and OCR the PDFs in Step 2 first."
            : "No guidelines found. Upload guideline PDFs in Step 2 first.",
        },
        { status: 404 },
      );
    }

    // Full regulatory audit: review EVERY clause of EVERY uploaded guideline.
    // No artificial cap — the number of findings is driven solely by the guideline
    // library and the SOP's compliance, never by a fixed limit.
    const guidelineClauses = guidelines.flatMap((g) =>
      resolveClauses(g).map((c) => ({
        clauseNumber: c.clauseNumber ?? "",
        clauseTitle: c.clauseTitle ?? "",
        clauseText: (c.clauseText ?? "").slice(0, MAX_CLAUSE_TEXT),
        guidelineName: g.name,
        folderName: g.folderName,
        pdfName: g.pdfName,
        guidelineId: g._id.toString(),
      })),
    );

    const scopedGuidelineIds = resolvedGuidelineIds.length ? resolvedGuidelineIds : undefined;

    console.log(
      `[analyze-v5] ${sop.identifier}: audit of ${guidelineClauses.length} clauses across ${guidelines.length} guideline(s)${scopedGuidelineIds ? ` (scoped: ${scopedGuidelineIds.length})` : " (all)"}`,
    );

    // SOP library for cross-SOP dependency validation.
    const libraryRows = await SOP.find({})
      .select("identifier name isObsolete expiryDate")
      .lean();
    const sopLibrary: SopLibraryEntry[] = libraryRows.map((s) => ({
      identifier: s.identifier,
      name: s.name,
      isObsolete: s.isObsolete,
      expiryDate: s.expiryDate ?? null,
    }));

    const effectiveProvider = providerOverride ?? getComplianceProvider();
    if (effectiveProvider === "ollama") {
      await warmupOllamaComplianceModel();
    }
    if (effectiveProvider === "claude") {
      const health = await checkClaudeCliHealth();
      if (!health.ok) {
        return NextResponse.json(
          { success: false, error: health.error ?? "Claude Code is not connected. Run: claude auth login" },
          { status: 503 },
        );
      }
    }
    if (effectiveProvider === "codex") {
      const health = await checkCodexCliHealth();
      if (!health.ok) {
        return NextResponse.json(
          { success: false, error: health.error ?? "Codex CLI is not connected. Run: codex login" },
          { status: 503 },
        );
      }
    }

    if (isComplianceRunActiveInProcess(sopId)) {
      return NextResponse.json(
        {
          success: false,
          error: "Compliance analysis already running for this SOP. Click Stop first or wait for it to finish.",
        },
        { status: 409 },
      );
    }

    const reviewMode =
      mode === "initial" || mode === "incremental" || mode === "auto" ? mode : "auto";

    const { runEpoch } = beginComplianceRun(sopId);
    try {
      const result = await runComplianceReview({
        sop,
        guidelineClauses,
        sopLibrary,
        provider: providerOverride,
        model: modelOverride,
        mode: reviewMode,
        forceRefresh: Boolean(forceRefresh),
        runEpoch,
        scopedGuidelineIds,
        annexuresChecked: resolved.annexureStatus === "checked",
        annexureStatus: resolved.annexureStatus,
        linkedAnnexureCount: resolved.linkedAnnexureCount,
        annexureChars: resolved.annexureSupplementChars,
        annexuresIncluded: resolved.annexuresIncluded,
        annexuresSkipped: resolved.annexuresSkipped,
      });

      await SOP.updateMany(
        { identifier: sop.identifier },
        {
          complianceStatus:
            result.overallScore >= 8 ? "compliant" : result.overallScore >= 5 ? "partial" : "non-compliant",
        },
      );

      return NextResponse.json({
        success: true,
        cached: result.mode === "cached",
        reviewMode: result.mode,
        sopIdentifier: sop.identifier,
        sopName: sop.name,
        overallScore: result.overallScore,
        complianceStatus: result.complianceStatus,
        compliantCount: result.compliantCount,
        partialCount: result.partialCount,
        nonCompliantCount: result.nonCompliantCount,
        criticalCount: result.criticalCount,
        majorCount: result.majorCount,
        minorCount: result.minorCount,
        improvementCount: result.improvementCount,
        clauseCoveragePct: result.clauseCoveragePct,
        totalGuidelinesChecked: result.totalGuidelinesChecked,
        processingTimeMs: result.processingTimeMs,
        findingsPersisted: result.findingsPersisted,
        findingsSkipped: result.findingsSkipped,
        findingsMerged: result.findingsMerged,
        incrementalReviewed: result.incrementalReviewed,
        incrementalResolved: result.incrementalResolved,
      });
    } catch (error) {
      if (isComplianceAnalysisCancelledError(error)) {
        return NextResponse.json({
          success: false,
          cancelled: true,
          error: "Analysis stopped by user",
        });
      }
      throw error;
    } finally {
      endComplianceRun(sopId);
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 },
    );
  }
}
