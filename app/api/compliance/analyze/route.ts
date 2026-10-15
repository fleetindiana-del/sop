import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import Guideline from "@/models/Guideline";
import ComplianceAnalysis from "@/models/ComplianceAnalysis";
import ComplianceReport from "@/models/ComplianceReport";
import { streamComplianceAnalysis } from "@/lib/gemini";
import {
  complianceStatusFromScore,
  getPipelineProgress,
} from "@/lib/pipeline";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { requireAuth } from "@/lib/withAuth";
import type { IComplianceFinding } from "@/models/ComplianceAnalysis";
import type { IComplianceReport } from "@/models/ComplianceReport";
import { enrichFindingSopContent } from "@/lib/ComplianceFindingValidator";
import { attachGapIdsToReportFindings } from "@/lib/compliance-finding-store";
import SOPGuideline from "@/models/SOPGuideline";
import { parseSopStructure } from "@/lib/sopStructureParser";
import { attachGuidelineSourceFields } from "@/lib/guidelineClauseDisplay";
import mongoose from "mongoose";
import { countLinkedAnnexureDocuments } from "@/lib/compliance-sop-content";
import { normalizeSopIdentifierKey, sopIdentifierEquivalentRegex } from "@/lib/sopIdentifierNormalize";
import RecheckRun from "@/models/RecheckRun";

const REPORT_ENRICH_CACHE_TTL_MS = 5 * 60 * 1000;
const fullReportCache = new Map<string, { at: number; report: unknown }>();

export type LatestRecheckSummary = {
  runId: string;
  score: number;
  verdict?: string;
  createdAt?: string;
  annexuresRead: boolean;
  annexureStatusTracked: boolean;
  annexureChars: number;
  annexureLabels: string[];
};

/** Attach newest RecheckRun per report for the Generated Reports table. */
async function attachLatestRecheckSummaries<T extends { _id?: unknown }>(
  reports: T[],
): Promise<(T & { latestRecheck?: LatestRecheckSummary | null })[]> {
  if (!reports.length) return reports.map((r) => ({ ...r, latestRecheck: null }));

  const reportIds = reports
    .map((r) => r._id)
    .filter((id) => !!id && mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (!reportIds.length) {
    return reports.map((r) => ({ ...r, latestRecheck: null }));
  }

  const latest = await RecheckRun.aggregate<{
    _id: mongoose.Types.ObjectId;
    runId: mongoose.Types.ObjectId;
    score: number;
    verdict?: string;
    createdAt?: Date;
    annexuresIncluded?: { label?: string; fileName?: string; chars?: number }[];
    annexureChars?: number;
    annexuresRead?: boolean;
  }>([
    { $match: { reportId: { $in: reportIds } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$reportId",
        runId: { $first: "$_id" },
        score: { $first: "$score" },
        verdict: { $first: "$verdict" },
        createdAt: { $first: "$createdAt" },
        annexuresIncluded: { $first: "$annexuresIncluded" },
        annexureChars: { $first: "$annexureChars" },
        annexuresRead: { $first: "$annexuresRead" },
      },
    },
  ]);

  const byReportId = new Map<string, LatestRecheckSummary>();
  for (const row of latest) {
    const included = Array.isArray(row.annexuresIncluded) ? row.annexuresIncluded : [];
    const labels = included
      .map((a) => (a.label || a.fileName || "").trim())
      .filter(Boolean);
    const annexureChars = typeof row.annexureChars === "number" ? row.annexureChars : 0;
    const tracked =
      typeof row.annexuresRead === "boolean" ||
      Array.isArray(row.annexuresIncluded) ||
      typeof row.annexureChars === "number";
    const annexuresRead =
      typeof row.annexuresRead === "boolean"
        ? row.annexuresRead
        : included.length > 0 || annexureChars > 0;

    byReportId.set(String(row._id), {
      runId: String(row.runId),
      score: typeof row.score === "number" ? row.score : 0,
      verdict: row.verdict,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      annexuresRead,
      annexureStatusTracked: tracked,
      annexureChars,
      annexureLabels: labels,
    });
  }

  return reports.map((r) => ({
    ...r,
    latestRecheck: byReportId.get(String(r._id)) ?? null,
  }));
}

/** Attach live SOP annexure linkage counts so the UI does not call legacy runs "none connected". */
async function attachLiveAnnexureCounts<
  T extends {
    sopId?: unknown;
    sopIdentifier?: string;
    linkedAnnexureCount?: number;
    liveLinkedAnnexureCount?: number;
  },
>(reports: T[]): Promise<(T & { liveLinkedAnnexureCount: number; linkedAnnexureCount: number })[]> {
  if (!reports.length) return [];

  const identifiers = [
    ...new Set(
      reports
        .map((r) => (typeof r.sopIdentifier === "string" ? r.sopIdentifier.trim() : ""))
        .filter(Boolean),
    ),
  ];
  const sopIds = reports
    .map((r) => r.sopId)
    .filter((id) => !!id && mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const orClauses: Record<string, unknown>[] = [];
  if (sopIds.length) orClauses.push({ _id: { $in: sopIds } });
  if (identifiers.length) orClauses.push({ identifier: { $in: identifiers } });
  if (!orClauses.length) {
    return reports.map((r) => ({
      ...r,
      liveLinkedAnnexureCount: 0,
      linkedAnnexureCount: r.linkedAnnexureCount ?? 0,
    }));
  }

  const sops = await SOP.find({
    isObsolete: { $ne: true },
    $or: orClauses,
  })
    .select("identifier sopDocuments")
    .lean();

  const byKey = new Map<string, typeof sops>();
  for (const sop of sops) {
    const key = normalizeSopIdentifierKey(String((sop as { identifier?: string }).identifier ?? ""));
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(sop);
    byKey.set(key, list);
  }

  const liveByKey = new Map<string, number>();
  for (const [key, family] of byKey) {
    liveByKey.set(key, countLinkedAnnexureDocuments(family as never));
  }

  return reports.map((r) => {
    const key = normalizeSopIdentifierKey(r.sopIdentifier ?? "");
    const live = liveByKey.get(key) ?? 0;
    return {
      ...r,
      liveLinkedAnnexureCount: live,
      linkedAnnexureCount: Math.max(r.linkedAnnexureCount ?? 0, live),
    };
  });
}

async function enrichFindingsClauseText<T extends {
  findings?: Array<{
    guidelineId?: unknown;
    clauseNumber?: string;
    folderName?: string;
    guidelineName?: string;
    clauseText?: string;
  }>;
  traceabilityMatrix?: Array<{ clauseNumber: string; folderName?: string; guidelineName?: string; clauseText?: string }>;
}>(report: T): Promise<T> {
  if (!report.findings?.length) return report;

  let enrichedFindings = report.findings.map((finding) => {
    if (finding.clauseText?.trim()) return finding;
    if (!report.traceabilityMatrix?.length) return finding;
    const folderKey = (finding.folderName || finding.guidelineName || "").toLowerCase();
    const match = report.traceabilityMatrix.find((m) => {
      if (m.clauseNumber !== finding.clauseNumber) return false;
      const mKey = (m.folderName || m.guidelineName || "").toLowerCase();
      return !folderKey || mKey === folderKey || m.guidelineName === finding.guidelineName;
    });
    return match?.clauseText?.trim() ? { ...finding, clauseText: match.clauseText.trim() } : finding;
  });

  const guidelineIds = [
    ...new Set(
      enrichedFindings
        .map((f) => f.guidelineId?.toString?.() ?? (f.guidelineId as string | undefined))
        .filter((id): id is string => !!id && mongoose.Types.ObjectId.isValid(id)),
    ),
  ];

  if (guidelineIds.length) {
    const guidelines = await SOPGuideline.find({ _id: { $in: guidelineIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("clauses.clauseNumber clauses.clauseText")
      .lean();

    const clauseByGuideline = new Map<string, Map<string, string>>();
    for (const g of guidelines) {
      const map = new Map<string, string>();
      for (const c of g.clauses ?? []) {
        if (c.clauseNumber && c.clauseText?.trim()) {
          map.set(c.clauseNumber, c.clauseText.trim());
        }
      }
      clauseByGuideline.set(g._id.toString(), map);
    }

    enrichedFindings = enrichedFindings.map((finding) => {
      const gid = finding.guidelineId?.toString?.() ?? (finding.guidelineId as string | undefined);
      if (!gid || !finding.clauseNumber) return finding;
      const full = clauseByGuideline.get(gid)?.get(finding.clauseNumber);
      if (!full) return finding;
      if (!finding.clauseText?.trim() || full.length > finding.clauseText.length) {
        return { ...finding, clauseText: full };
      }
      return finding;
    });
  }

  return { ...report, findings: enrichedFindings };
}

function enrichFindingsGuidelineDisplay<T extends {
  findings?: Array<{
    clauseNumber?: string;
    clauseTitle?: string;
    clauseText?: string;
    guidelineRequirement?: string;
    guidelineReference?: string;
    guidelineSourceLine?: string;
    guidelineLineNumber?: string;
    guidelineSearchPhrase?: string;
    mismatchExplanation?: string;
    highlightedIssue?: string;
    sopTextSnippet?: string;
    evidenceFound?: string;
  }>;
}>(report: T): T {
  if (!report.findings?.length) return report;

  const findings = report.findings.map((finding) => attachGuidelineSourceFields(finding));

  return { ...report, findings };
}

async function enrichReportFindings<T extends { sopId: unknown; findings?: IComplianceReport["findings"] }>(
  report: T,
): Promise<T> {
  if (!report.findings?.length) return report;

  const sop = await SOP.findById(report.sopId).select("content identifier name").lean();
  if (!sop?.content?.trim()) return report;

  const parsedSop = parseSopStructure(sop.content);
  const enrichedFindings = report.findings.map((finding) => {
    const enriched = enrichFindingSopContent(
      {
        clauseNumber: finding.clauseNumber,
        clauseTitle: finding.clauseTitle,
        complianceLevel: finding.complianceLevel,
        matchConfidence: finding.matchConfidence,
        issueSeverity: finding.issueSeverity,
        sopSectionAffected: finding.sopSectionAffected,
        mismatchExplanation: finding.mismatchExplanation,
        sopTextSnippet: finding.sopTextSnippet,
        guidelineRequirement: finding.guidelineRequirement,
        suggestedAction: finding.suggestedAction,
        suggestedText: finding.suggestedText,
        impactAnalysis: finding.impactAnalysis,
        estimatedEffort: finding.estimatedEffort,
        guidelineName: finding.guidelineName,
        folderName: finding.folderName,
      },
      parsedSop,
      sop.identifier,
      sop.name,
    );
    return {
      ...finding,
      sopTextSnippet: enriched.sopTextSnippet,
      sopSectionAffected: enriched.sopSectionAffected,
    };
  });

  return { ...report, findings: enrichedFindings };
}

async function attachGapMetadata<T extends { sopId: unknown; findings?: IComplianceReport["findings"] }>(
  report: T,
): Promise<T> {
  if (!report.findings?.length || !report.sopId) return report;
  const mapped = report.findings.map((f) => ({
    ...f,
    guidelineId: f.guidelineId?.toString?.() ?? f.guidelineId,
  }));
  const withGaps = await attachGapIdsToReportFindings(String(report.sopId), mapped as Parameters<typeof attachGapIdsToReportFindings>[1]);
  return { ...report, findings: withGaps as unknown as IComplianceReport["findings"] };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const reportId = request.nextUrl.searchParams.get("reportId");

    if (reportId) {
      const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";
      const cached = bypassCache ? undefined : fullReportCache.get(reportId);
      if (cached && Date.now() - cached.at < REPORT_ENRICH_CACHE_TTL_MS) {
        return NextResponse.json({ success: true, report: cached.report });
      }

      const report = await ComplianceReport.findById(reportId).lean();
      if (!report) return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });
      const withClauseText = await enrichFindingsClauseText(report);
      const withGuidelineLine = enrichFindingsGuidelineDisplay(withClauseText);
      const enriched = await enrichReportFindings(withGuidelineLine);
      const withGaps = await attachGapMetadata(enriched);
      const [withAnnexures] = await attachLiveAnnexureCounts([withGaps]);
      const [withRecheck] = await attachLatestRecheckSummaries([withAnnexures]);
      fullReportCache.set(reportId, { at: Date.now(), report: withRecheck });
      return NextResponse.json({ success: true, report: withRecheck });
    }

    const reports = await ComplianceReport.find({})
      .sort({ analyzedAt: -1 })
      .limit(200)
      .select("-findings -traceabilityMatrix -crossSopDependencies")
      .lean();

    const withAnnexures = await attachLiveAnnexureCounts(reports);
    const withRecheck = await attachLatestRecheckSummaries(withAnnexures);
    return NextResponse.json({ success: true, reports: withRecheck });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch reports" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const reportId = request.nextUrl.searchParams.get("reportId");
    if (!reportId || !mongoose.Types.ObjectId.isValid(reportId)) {
      return NextResponse.json({ success: false, error: "Valid reportId required" }, { status: 400 });
    }
    await ComplianceReport.findByIdAndDelete(reportId);
    fullReportCache.delete(reportId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete report" },
      { status: 500 },
    );
  }
}

function emitLine(controller: ReadableStreamDefaultController, data: Record<string, unknown>) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(data)}\n`));
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const sopIdentifier = body.sopIdentifier?.trim();
    const guidelineId = body.guidelineId?.trim();

    if (!sopIdentifier || !guidelineId) {
      return NextResponse.json(
        { error: "sopIdentifier and guidelineId are required" },
        { status: 400 },
      );
    }

    const sops = await SOP.find({ identifier: sopIdentifierEquivalentRegex(sopIdentifier) });
    const sop = sops.find((s) => s.language !== "Gujarati") ?? sops[0];
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    const guideline = await Guideline.findById(guidelineId);
    if (!guideline) {
      return NextResponse.json({ error: "Guideline not found" }, { status: 404 });
    }

    const systemPrompt = `You are a pharmaceutical regulatory compliance auditor.
Review the SOP against each guideline clause. Return ONLY valid JSON:
{
  "score": number (0-10),
  "findings": [
    {
      "clause": "clause number",
      "title": "clause title",
      "status": "compliant"|"partial"|"non-compliant"|"not-applicable",
      "severity": "critical"|"major"|"minor"|"informational",
      "description": "...",
      "recommendation": "...",
      "confidence": number (0-1)
    }
  ]
}`;

    const clausesText = guideline.clauses
      .map((c) => `Clause ${c.number}: ${c.title}\n${c.text}`)
      .join("\n\n");

    const userPrompt = `Guideline: ${guideline.name} (${guideline.folder})
SOP Identifier: ${sop.identifier}
SOP Name: ${sop.name}

GUIDELINE CLAUSES:
${clausesText}

SOP CONTENT:
${sop.content.slice(0, 60000)}`;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          emitLine(controller, {
            type: "log",
            message: `[${new Date().toISOString()}] Starting compliance analysis for ${sop.identifier}...`,
          });
          emitLine(controller, {
            type: "log",
            message: `[${new Date().toISOString()}] Loaded ${guideline.clauses.length} clauses from ${guideline.name}`,
          });

          let accumulated = "";
          for await (const chunk of streamComplianceAnalysis(systemPrompt, userPrompt)) {
            accumulated += chunk;
            emitLine(controller, {
              type: "log",
              message: `[${new Date().toISOString()}] Receiving analysis stream... (${accumulated.length} chars)`,
            });
          }

          const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("Failed to parse compliance JSON from model");

          const parsed = JSON.parse(jsonMatch[0]) as {
            score: number;
            findings: IComplianceFinding[];
          };

          for (const finding of parsed.findings ?? []) {
            emitLine(controller, { type: "finding", finding });
          }

          const score = Math.min(10, Math.max(0, parsed.score ?? 0));
          const complianceStatus = complianceStatusFromScore(score);

          const analysis = await ComplianceAnalysis.create({
            sopId: sop._id,
            sopIdentifier: sop.identifier,
            guidelineId: guideline._id,
            guidelineName: guideline.name,
            score,
            findings: parsed.findings ?? [],
            clauseCount: guideline.clauses.length,
            analyzedAt: new Date(),
          });

          await SOP.updateMany(
            { identifier: sop.identifier },
            { complianceStatus, pipelineStatus: "approved" },
          );

          invalidateDashboardSopsCache();

          emitLine(controller, {
            type: "complete",
            score,
            findingsCount: parsed.findings?.length ?? 0,
            analysisId: analysis._id.toString(),
            complianceStatus,
            progress: getPipelineProgress("approved"),
          });
        } catch (err) {
          emitLine(controller, {
            type: "error",
            message: err instanceof Error ? err.message : "Analysis failed",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 },
    );
  }
}
