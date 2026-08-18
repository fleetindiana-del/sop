import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { connectDB } from "@/lib/mongodb";
import SOP, { type ISOP } from "@/models/SOP";
import ComplianceReport from "@/models/ComplianceReport";
import { requireAuth } from "@/lib/withAuth";
import { detectFileType, saveUploadedBuffer } from "@/lib/upload";
import { extractTextFromBuffer } from "@/lib/extractContent";
import { processGuidelinePDF } from "@/lib/ocrProcessor";
import { generateComplianceJson } from "@/lib/llm";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import RecheckRun, { type IRecheckAnnexure } from "@/models/RecheckRun";
import { computeRecheckScore } from "@/lib/recheckScore";
import {
  buildAnnexureSupplementDetailed,
  LINKED_ANNEXURES_MARKER,
  windowSopContentForAudit,
  type AnnexureIncludeInfo,
} from "@/lib/compliance-sop-content";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";
import { findSuggestedTextInRevised, type SuggestionMatch } from "@/lib/recheckResolution";
import {
  extractSopSectionId,
  parseSopStructure,
  resolveSectionForExcerpt,
} from "@/lib/sopStructureParser";

export const maxDuration = 300;

// Cap the revised SOP (+ annexures) text sent to the model to stay within context limits.
// Kept generous so late sections (where fixes are usually appended) reach the model intact.
const MAX_SOP_CHARS = 90_000;

interface PriorPoint {
  clauseNumber: string;
  clauseTitle: string;
  guidelineName: string;
  requirement: string;
  gap: string;
  suggestedAction: string;
}

interface PointCheck {
  index: number;
  status: "resolved" | "open";
  evidence: string;
  note: string;
  revisedExcerpt: string;
  /** Section number in the REVISED SOP where evidence/revisedExcerpt sits (e.g. "5.13.7"). */
  revisedSopSection?: string;
}

/** A verdict banked by an earlier re-check (or by the report itself) that must not regress. */
interface CarriedVerdict {
  evidence: string;
  note: string;
  revisedExcerpt: string;
  revisedSopSection: string;
  ignored: boolean;
}

type RunAnnexure = IRecheckAnnexure;

/** Match an uploaded annexure to the linked copy it replaces (extension/spacing insensitive). */
function annexureNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Marker stored on synthetic findings built from an earlier run's new issue. */
const ISSUE_KEY_FIELD = "__recheckIssueKey";

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Stable identity of a finding across runs — guideline + clause, as used when saving progress. */
function findingKey(f: {
  guidelineName?: unknown;
  clauseNumber?: unknown;
  [ISSUE_KEY_FIELD]?: unknown;
}): string {
  const issueKey = norm(f[ISSUE_KEY_FIELD]);
  if (issueKey) return issueKey;
  return `${norm(f.guidelineName)}|${norm(f.clauseNumber)}`;
}

/**
 * Identity of a new issue. Clause-based when the model named one, otherwise the issue
 * text itself — so the same finding raised twice never becomes two points.
 */
function newIssueKey(n: {
  guidelineName?: unknown;
  clauseNumber?: unknown;
  issue?: unknown;
}): string {
  const clause = norm(n.clauseNumber);
  if (clause) return `issue:${norm(n.guidelineName)}|${clause}`;
  return `issue:${norm(n.issue).replace(/\s+/g, " ").slice(0, 160)}`;
}

/** Render an earlier run's new issue as a finding so it re-verifies like any other point. */
function issueToFinding(n: {
  clauseNumber?: string;
  clauseTitle?: string;
  guidelineName?: string;
  issue?: string;
  severity?: string;
  suggestion?: string;
}): Record<string, unknown> {
  const severityMap: Record<string, string> = {
    high: "critical",
    medium: "major",
    low: "minor",
  };
  return {
    guidelineName: n.guidelineName ?? "",
    clauseNumber: n.clauseNumber ?? "",
    clauseTitle: n.clauseTitle ?? "",
    complianceLevel: "non-compliant",
    matchConfidence: 0,
    issueSeverity: severityMap[n.severity ?? "medium"] ?? "major",
    mismatchExplanation: n.issue ?? "",
    suggestedAction: n.suggestion ?? "",
    [ISSUE_KEY_FIELD]: newIssueKey(n),
  };
}

interface NewIssue {
  clauseNumber: string;
  clauseTitle?: string;
  guidelineName?: string;
  title?: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
}

interface RecheckModelResult {
  pointChecks: PointCheck[];
  newIssues: NewIssue[];
}

function buildSystemPrompt(): string {
  return [
    "You are a senior pharmaceutical GMP compliance auditor.",
    "You are given the full text of a REVISED SOP (which may include LINKED ANNEXURES — forms, logs, and record templates) and a list of compliance gaps that were previously identified against regulatory guidelines (ICH, EU-GMP, WHO, PIC/S).",
    "Do TWO things:",
    "1. For EACH prior gap, decide whether the revised SOP / annexures now ADDRESSES it. status='resolved' if the revised text clearly satisfies the requirement, otherwise status='open'. Quote the supporting sentence from the revised SOP or annexure in 'evidence' when resolved; when open, briefly say what is still missing in 'note'.",
    "1b. For EACH prior gap, ALSO return 'revisedExcerpt': the exact sentence(s) from the REVISED SOP or LINKED ANNEXURE that are most relevant to this requirement — the section that now covers it (whether fully, partially, or not at all). This must always be populated with the closest matching revised text, even when status is 'open'.",
    "1c. Gaps about data not being tracked, missing forms, logs, or record templates MUST be marked resolved when a linked annexure provides that tracking/form evidence.",
    "1d. JUDGE THE WHOLE DOCUMENT, NOT ONE SECTION. A prior gap names the section, clause, or annexure where it was FIRST observed — that is only where the auditor looked, NOT where the fix must live. Search the ENTIRE revised SOP (every section and clause, all annexures, forms, logs, and record templates) for text that satisfies the requirement. If the requirement is covered ANYWHERE in the document, status='resolved' — even when the wording sits in a different section, a different clause number, or an annexure than the one named in the prior gap.",
    "1e. If the revised SOP contains the 'Suggested action' text (verbatim or reworded, under any clause number), that gap is RESOLVED — quote it in 'evidence'.",
    "1f. For EACH prior gap, ALSO return 'revisedSopSection': the numbered section heading in the REVISED SOP (or annexure label) where your evidence/revisedExcerpt actually appears — e.g. '5.13.7' or 'Annexure-I'. Do NOT copy the original gap's section if the revised text lives elsewhere.",
    "2. Scan the revised SOP for NEW issues, but be CONSERVATIVE: only raise a new issue when it is a clear, material violation of a SPECIFIC regulatory guideline requirement (name the guideline/clause). Do NOT invent, pad, or force new points. Do NOT raise stylistic, speculative, or minor issues. If nothing material is found, return an empty newIssues array.",
    "2b. NEVER repeat a point that is already in the prior-gaps list, and never repeat a point listed under ALREADY REPORTED — those are tracked separately. A requirement that the revised SOP or an annexure now covers must not be raised again in any form.",
    "Be strict and evidence-based. Do not mark a point resolved unless the revised text genuinely covers it.",
    "Respond with ONLY valid JSON in exactly this shape:",
    '{"pointChecks":[{"index":0,"status":"resolved"|"open","evidence":"string","note":"string","revisedExcerpt":"string","revisedSopSection":"string"}],"newIssues":[{"clauseNumber":"string","clauseTitle":"string","guidelineName":"string","issue":"string","severity":"low"|"medium"|"high","suggestion":"string"}]}',
    "The 'index' in each pointCheck MUST match the index of the prior gap in the provided list. Return one pointCheck per prior gap.",
  ].join("\n");
}

function buildUserPrompt(
  priorPoints: PriorPoint[],
  revisedText: string,
  alreadyReported: string[],
): string {
  const priorList = priorPoints
    .map((p, i) =>
      [
        `#${i} [${p.guidelineName} ${p.clauseNumber} ${p.clauseTitle}]`,
        `Requirement: ${p.requirement || "(n/a)"}`,
        `Prior gap (observed here originally — the fix may now live anywhere in the SOP): ${p.gap || "(n/a)"}`,
        `Suggested action: ${p.suggestedAction || "(n/a)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "PRIOR COMPLIANCE GAPS (index → gap):",
    priorList || "(none)",
    "",
    "ALREADY REPORTED IN EARLIER RE-CHECKS (do NOT raise any of these again as a new issue):",
    alreadyReported.length ? alreadyReported.map((t) => `- ${t}`).join("\n") : "(none)",
    "",
    "REVISED SOP TEXT — the COMPLETE document (may include uploaded and linked annexures). Check every gap against ALL of it, not just the section named in the gap:",
    windowSopContentForAudit(revisedText, MAX_SOP_CHARS),
  ].join("\n");
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const formData = await request.formData();
    const reportId = (formData.get("reportId") as string | null)?.trim();
    const file = formData.get("file") as File | null;
    const annexureFiles = formData
      .getAll("annexures")
      .filter((v): v is File => v instanceof File && v.size > 0);

    if (!reportId || !file) {
      return NextResponse.json(
        { success: false, error: "reportId and file are required" },
        { status: 400 },
      );
    }

    const report = await ComplianceReport.findById(reportId);
    if (!report) {
      return NextResponse.json({ success: false, error: "Report not found" }, { status: 404 });
    }

    const fileType = detectFileType(file.name);
    if (!fileType) {
      return NextResponse.json(
        { success: false, error: "Unsupported file type — upload a PDF or DOCX" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let revisedText = "";
    if (fileType === "docx") {
      revisedText = await extractTextFromBuffer(buffer, "docx");
    } else {
      const ocr = await processGuidelinePDF(buffer);
      revisedText = ocr.text ?? "";
    }

    if (!revisedText || revisedText.trim().length < 50) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not extract readable text from the uploaded SOP. Upload a DOCX for best results.",
        },
        { status: 422 },
      );
    }

    // Text for LLM audit may include annexures; stored SOP content stays the uploaded procedure only.
    const mainRevisedText = revisedText;
    let auditText = revisedText;
    const annexuresIncluded: RunAnnexure[] = [];
    const annexuresSkipped: { label: string; fileName: string; reason: string }[] = [];
    const annexureChunks: string[] = [];

    // Annexures uploaded with this re-check are the freshest evidence — they are read first
    // and supersede any older copy of the same file linked to the SOP record.
    for (const annexFile of annexureFiles) {
      const label = annexFile.name.replace(/\.[^.]+$/, "").trim() || "Annexure";
      const annexType = detectFileType(annexFile.name);
      if (!annexType) {
        annexuresSkipped.push({
          label,
          fileName: annexFile.name,
          reason: "unsupported file type — upload PDF or DOCX",
        });
        continue;
      }
      try {
        const annexBuffer = Buffer.from(await annexFile.arrayBuffer());
        const text =
          annexType === "docx"
            ? await extractTextFromBuffer(annexBuffer, "docx")
            : (await processGuidelinePDF(annexBuffer)).text ?? "";
        if (!text || text.trim().length < 30) {
          annexuresSkipped.push({ label, fileName: annexFile.name, reason: "no extractable text" });
          continue;
        }
        const body = text.trim().slice(0, 12_000);
        let annexUrl = "";
        try {
          const saved = await saveUploadedBuffer(
            annexBuffer,
            `recheck-annexure-${Date.now()}-${annexFile.name}`,
            report.department || "General",
            report.sopIdentifier || "SOP",
            "English",
          );
          annexUrl = saved.fileUrl;
        } catch {
          /* storage not configured — the text is still audited, just not linkable */
        }
        annexureChunks.push(`--- ${label} (uploaded with this re-check) ---\n${body}`);
        annexuresIncluded.push({
          label,
          fileName: annexFile.name,
          chars: body.length,
          source: "uploaded",
          fileUrl: annexUrl,
        });
      } catch (err) {
        annexuresSkipped.push({
          label,
          fileName: annexFile.name,
          reason: err instanceof Error ? err.message : "extract failed",
        });
      }
    }

    const uploadedAnnexureCount = annexuresIncluded.length;
    const uploadedAnnexureKeys = new Set(
      annexuresIncluded.flatMap((a) => [annexureNameKey(a.fileName), annexureNameKey(a.label)]),
    );

    // Fold in linked annexures (forms/logs) so record-tracking gaps can resolve on recheck.
    if (report.sopId) {
      try {
        const primary = (await SOP.findById(report.sopId).lean()) as ISOP | null;
        if (primary) {
          const family = (await SOP.find({
            ...sopIdentifierMatchFilter(primary.identifier),
            isObsolete: { $ne: true },
          }).lean()) as ISOP[];
          const annexureResult = await buildAnnexureSupplementDetailed(
            family.length ? family : [primary],
            {
              exclude: ({ label, fileName }) =>
                uploadedAnnexureKeys.has(annexureNameKey(fileName)) ||
                uploadedAnnexureKeys.has(annexureNameKey(label)),
            },
          );
          annexuresIncluded.push(
            ...annexureResult.included.map((a: AnnexureIncludeInfo) => ({
              ...a,
              source: "linked" as const,
            })),
          );
          annexuresSkipped.push(...annexureResult.skipped);
          if (annexureResult.text) annexureChunks.push(annexureResult.text);
        }
      } catch (err) {
        console.warn(
          "[recheck] could not load linked annexures:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const annexureText = annexureChunks.join("\n\n").slice(0, 48_000);
    const annexureChars = annexureText.length;
    if (annexureText) {
      auditText = [
        `=== MAIN SOP PROCEDURE ===\n${mainRevisedText}`,
        `${LINKED_ANNEXURES_MARKER}\n${annexureText}`,
      ].join("\n\n");
      console.log(
        `[recheck] ${report.sopIdentifier}: merged ${annexureChars} chars from ${annexuresIncluded.length} annexure(s) (${uploadedAnnexureCount} uploaded): ${annexuresIncluded.map((a) => a.label).join(", ")}`,
      );
    } else {
      console.log(
        `[recheck] ${report.sopIdentifier}: no readable annexures (${annexuresSkipped.length} skipped)`,
      );
    }

    // Prior actionable gaps to re-verify.
    const reportFindings = (report.findings ?? []).filter(
      (f) => f.complianceLevel === "partial" || f.complianceLevel === "non-compliant",
    );

    // Progress already banked must never regress. A point that an earlier re-check (or a
    // manual review on the report) marked addressed is carried forward as-is instead of
    // being re-audited — the model is non-deterministic and would otherwise flip already
    // solved points back to open, dropping the score on every subsequent run.
    const priorRuns = (await RecheckRun.find({ reportId: report._id })
      .sort({ createdAt: 1 })
      .select("results newIssues")
      .lean()) as {
      results?: {
        finding?: Record<string, unknown>;
        status?: string;
        evidence?: string;
        note?: string;
        revisedExcerpt?: string;
        revisedSopSection?: string;
        ignored?: boolean;
      }[];
      newIssues?: {
        clauseNumber?: string;
        clauseTitle?: string;
        guidelineName?: string;
        issue?: string;
        severity?: string;
        suggestion?: string;
        ignored?: boolean;
      }[];
    }[];

    const carriedByKey = new Map<string, CarriedVerdict>();
    for (const run of priorRuns) {
      for (const r of run.results ?? []) {
        if (r.status !== "addressed" || !r.finding) continue;
        carriedByKey.set(findingKey(r.finding), {
          evidence: r.evidence ?? "",
          note: r.note ?? "",
          revisedExcerpt: r.revisedExcerpt ?? "",
          revisedSopSection: r.revisedSopSection ?? "",
          ignored: !!r.ignored,
        });
      }
    }

    // An issue raised by an earlier re-check becomes a tracked point from now on, so this
    // upload verifies it (and it can be carried forward once fixed) instead of the model
    // reporting the same thing again on every run.
    const reportClauseKeys = new Set(reportFindings.map((f) => findingKey(f)));
    const trackedIssueKeys = new Set<string>();
    const ignoredIssueKeys = new Set<string>();
    const carriedIssueFindings: Record<string, unknown>[] = [];
    for (const run of priorRuns) {
      for (const n of run.newIssues ?? []) {
        const key = newIssueKey(n);
        const clauseKey = `${norm(n.guidelineName)}|${norm(n.clauseNumber)}`;
        // An issue the user chose to ignore stays ignored once it becomes a point.
        if (n.ignored) ignoredIssueKeys.add(key);
        else ignoredIssueKeys.delete(key);
        if (trackedIssueKeys.has(key)) continue;
        if (norm(n.clauseNumber) && reportClauseKeys.has(clauseKey)) continue;
        trackedIssueKeys.add(key);
        carriedIssueFindings.push(issueToFinding(n));
      }
    }

    const priorEntries: {
      finding: Record<string, unknown>;
      origin: "report" | "new-issue";
      closedOnReport: boolean;
    }[] = [
      ...reportFindings.map((f) => ({
        finding: JSON.parse(JSON.stringify(f)) as Record<string, unknown>,
        origin: "report" as const,
        closedOnReport: f.resolved === true || f.reviewStatus === "implemented",
      })),
      ...carriedIssueFindings.map((finding) => ({
        finding,
        origin: "new-issue" as const,
        closedOnReport: false,
      })),
    ];

    const priorPoints: PriorPoint[] = priorEntries.map(({ finding: f }) => ({
      clauseNumber: String(f.clauseNumber ?? ""),
      clauseTitle: String(f.clauseTitle ?? ""),
      guidelineName: String(f.guidelineName ?? ""),
      requirement: String(f.guidelineRequirement ?? ""),
      gap: String(f.mismatchExplanation ?? ""),
      suggestedAction: String(f.suggestedText ?? "").trim() || String(f.suggestedAction ?? ""),
    }));

    const carriedByIndex = new Map<number, CarriedVerdict>();
    const toCheckIndexes: number[] = [];
    priorEntries.forEach((entry, i) => {
      const carried = carriedByKey.get(findingKey(entry.finding));
      if (carried || entry.closedOnReport) {
        carriedByIndex.set(
          i,
          carried ?? {
            evidence: "",
            note: "",
            revisedExcerpt: "",
            revisedSopSection: "",
            ignored: false,
          },
        );
      } else {
        toCheckIndexes.push(i);
      }
    });

    // Everything already tracked but not re-sent to the model — listed so it is never re-raised.
    const alreadyReported = priorEntries
      .filter((_, i) => carriedByIndex.has(i))
      .map(({ finding: f }) =>
        [f.guidelineName, f.clauseNumber, f.clauseTitle, f.mismatchExplanation]
          .map((v) => String(v ?? "").trim())
          .filter(Boolean)
          .join(" · ")
          .slice(0, 220),
      )
      .filter(Boolean);

    if (carriedByIndex.size > 0) {
      console.log(
        `[recheck] ${report.sopIdentifier}: carrying forward ${carriedByIndex.size} already-addressed point(s); re-auditing ${toCheckIndexes.length} (${carriedIssueFindings.length} from earlier new issues)`,
      );
    }

    // Targeted per-point check + new-issue scan in one structured call.
    let modelResult: RecheckModelResult = { pointChecks: [], newIssues: [] };
    try {
      modelResult = await generateComplianceJson<RecheckModelResult>(
        buildSystemPrompt(),
        buildUserPrompt(
          toCheckIndexes.map((i) => priorPoints[i]),
          auditText,
          alreadyReported,
        ),
        "codex",
      );
    } catch (err) {
      return NextResponse.json(
        {
          success: false,
          error:
            err instanceof Error
              ? `AI re-check failed: ${err.message}`
              : "AI re-check failed",
        },
        { status: 502 },
      );
    }

    const pointChecks = Array.isArray(modelResult.pointChecks) ? modelResult.pointChecks : [];
    const rawIssues = Array.isArray(modelResult.newIssues) ? modelResult.newIssues : [];

    // Merge model verdicts onto the prior findings; keep the FULL finding snapshot
    // so the client renders each point with the exact same card/data as the report.
    // The model only saw the points still open, so its indices are positions in
    // toCheckIndexes — map them back onto the full prior-findings list.
    const checkByIndex = new Map<number, PointCheck>();
    for (const c of pointChecks) {
      if (typeof c.index !== "number") continue;
      const originalIndex = toCheckIndexes[c.index];
      if (originalIndex !== undefined) checkByIndex.set(originalIndex, c);
    }
    // Deterministic safety net: the model anchors on the section a gap was first observed
    // in and can miss the fix when it was added elsewhere in the SOP. Scan the FULL
    // untruncated document for the suggested remediation text; if it is there, the point
    // is addressed regardless of where it sits or what the model said.
    let textVerifiedCount = 0;
    const textVerified = new Map<number, SuggestionMatch>();
    for (const i of toCheckIndexes) {
      if (checkByIndex.get(i)?.status === "resolved") continue;
      const match = findSuggestedTextInRevised(priorPoints[i].suggestedAction, auditText);
      if (!match.matched) continue;
      textVerified.set(i, match);
      textVerifiedCount++;
    }
    if (textVerifiedCount > 0) {
      console.log(
        `[recheck] ${report.sopIdentifier}: ${textVerifiedCount} point(s) marked addressed by full-document text match (suggested clause found elsewhere in the SOP)`,
      );
    }

    // Map revised excerpts back onto the REVISED SOP's section numbering so the UI
    // § badge reflects where the text actually lives (not the original finding's section).
    const parsedRevised = parseSopStructure(mainRevisedText);

    const resolveRevisedSection = (
      excerpt: string,
      modelSection?: string,
      fallbackFindingSection?: unknown,
    ): string => {
      const resolved = resolveSectionForExcerpt(parsedRevised, excerpt);
      if (resolved.label) return resolved.label;
      if (resolved.id) return resolved.id;
      const fromModel = (modelSection || "").trim();
      if (fromModel) return fromModel;
      const fromExcerpt = extractSopSectionId(excerpt);
      if (fromExcerpt) return fromExcerpt;
      return extractSopSectionId(String(fallbackFindingSection ?? "")) || "";
    };

    const results = priorEntries.map(({ finding, origin }, i) => {
      const carried = carriedByIndex.get(i);
      if (carried) {
        const carriedExcerpt = carried.evidence || carried.revisedExcerpt;
        return {
          finding,
          status: "addressed" as const,
          evidence: carried.evidence,
          note: carried.note,
          revisedExcerpt: carried.revisedExcerpt,
          revisedSopSection:
            carried.revisedSopSection ||
            resolveRevisedSection(carriedExcerpt, undefined, finding.sopSectionAffected),
          ignored: carried.ignored,
          carriedForward: true,
          origin,
        };
      }
      const c = checkByIndex.get(i);
      const verified = textVerified.get(i);
      const status: "addressed" | "open" =
        c?.status === "resolved" || verified ? "addressed" : "open";
      const evidence = verified ? verified.excerpt : c?.evidence ?? "";
      const revisedExcerpt = verified ? verified.excerpt : c?.revisedExcerpt ?? "";
      const sectionSource = status === "addressed" ? evidence || revisedExcerpt : revisedExcerpt || evidence;
      return {
        finding,
        status,
        evidence,
        note: verified
          ? `Suggested text found in the revised SOP (${Math.round(verified.coverage * 100)}% match) — covered outside the originally flagged section.`
          : c?.note ?? "",
        revisedExcerpt,
        revisedSopSection: resolveRevisedSection(
          sectionSource,
          c?.revisedSopSection,
          finding.sopSectionAffected,
        ),
        ignored: origin === "new-issue" && ignoredIssueKeys.has(findingKey(finding)),
        carriedForward: false,
        origin,
      };
    });

    // Drop anything the model re-reported that is already tracked as a point (from the
    // report or an earlier run) or that it listed twice — a gap fixed in the SOP or in an
    // annexure must never come back as a "new" issue.
    const trackedPointKeys = new Set(priorEntries.map(({ finding }) => findingKey(finding)));
    const emittedIssueKeys = new Set(trackedIssueKeys);
    const newIssues = rawIssues
      .map((n) => ({
        clauseNumber: n.clauseNumber ?? "",
        clauseTitle: n.clauseTitle ?? n.title ?? "",
        guidelineName: n.guidelineName ?? "",
        issue: n.issue ?? "",
        severity: (["low", "medium", "high"].includes(n.severity) ? n.severity : "medium") as
          | "low"
          | "medium"
          | "high",
        suggestion: n.suggestion ?? "",
        ignored: false,
      }))
      .filter((n) => {
        if (!n.issue.trim()) return false;
        const key = newIssueKey(n);
        const clauseKey = `${norm(n.guidelineName)}|${norm(n.clauseNumber)}`;
        if (emittedIssueKeys.has(key)) return false;
        if (norm(n.clauseNumber) && trackedPointKeys.has(clauseKey)) return false;
        emittedIssueKeys.add(key);
        return true;
      });

    if (rawIssues.length !== newIssues.length) {
      console.log(
        `[recheck] ${report.sopIdentifier}: dropped ${rawIssues.length - newIssues.length} duplicate/already-tracked new issue(s)`,
      );
    }

    const { score, verdict, resolvedCount, openCount } = computeRecheckScore(results, newIssues);
    const isCompliant = verdict === "compliant";

    // Store the exact uploaded document once, reused for both history + SOP record.
    let uploadedUrl = "";
    try {
      const uniqueName = `recheck-${Date.now()}-${file.name}`;
      const { fileUrl } = await saveUploadedBuffer(
        buffer,
        uniqueName,
        report.department || "General",
        report.sopIdentifier || "SOP",
        "English",
      );
      uploadedUrl = fileUrl;
    } catch {
      /* storage not configured — history keeps no openable link */
    }

    // Replace the SOP's stored content with the revised text (versioning the SOP).
    let sopUpdated = false;
    if (report.sopId) {
      const sop = await SOP.findById(report.sopId);
      if (sop) {
        sop.content = mainRevisedText;
        sop.checksum = createHash("sha256").update(buffer).digest("hex");
        sop.lastReviewedAt = new Date();
        sop.processedAt = new Date();
        if (typeof sop.versionNum === "number") sop.versionNum = sop.versionNum + 1;
        if (uploadedUrl) {
          sop.fileUrl = uploadedUrl;
          sop.fileType = fileType;
        }
        await sop.save();
        sopUpdated = true;
      }
    }

    // Persist progress: addressed prior gaps are marked implemented on the report.
    if (resolvedCount > 0) {
      const addressedKeys = new Set(
        results.filter((r) => r.status === "addressed").map((r) => findingKey(r.finding)),
      );
      report.findings = report.findings.map((f) => {
        if (
          (f.complianceLevel === "partial" || f.complianceLevel === "non-compliant") &&
          addressedKeys.has(findingKey(f))
        ) {
          f.reviewStatus = "implemented";
          f.resolved = true;
        }
        return f;
      });
      await report.save();
    }

    if (sopUpdated) invalidateDashboardSopsCache();

    // Persist this run as history — points ordered by original SOP section.
    const sectionSortKey = (section?: unknown): number[] => {
      const raw = String(section || "").trim();
      if (!raw || /^(not found|n\/a|general)$/i.test(raw)) return [];
      const secMark = raw.match(/§\s*([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/);
      const id =
        secMark?.[1]
        || raw.replace(/\bL\d{3,}\b/gi, " ").match(/(\d+(?:\.\d+)*)/)?.[1]
        || "";
      if (!id || !/^\d/.test(id)) return [];
      return id.split(".").map((p) => {
        const n = Number(p);
        return Number.isFinite(n) ? n : -1;
      });
    };
    const compareByOriginalSection = (
      a: (typeof results)[number],
      b: (typeof results)[number],
    ): number => {
      const pa = sectionSortKey(a.finding?.sopSectionAffected);
      const pb = sectionSortKey(b.finding?.sopSectionAffected);
      if (pa.length === 0 || pb.length === 0) {
        if (pa.length !== pb.length) return pa.length === 0 ? 1 : -1;
      } else {
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
          const va = pa[i] ?? -1;
          const vb = pb[i] ?? -1;
          if (va !== vb) return va - vb;
        }
      }
      return String(a.finding?.sopSectionAffected || "").localeCompare(
        String(b.finding?.sopSectionAffected || ""),
      );
    };
    results.sort(compareByOriginalSection);

    const run = await RecheckRun.create({
      reportId: report._id,
      sopId: report.sopId,
      sopIdentifier: report.sopIdentifier,
      sopName: report.sopName,
      department: report.department,
      fileName: file.name,
      fileUrl: uploadedUrl,
      verdict,
      score,
      resolvedCount,
      openCount,
      results,
      newIssues,
      annexuresIncluded,
      annexuresSkipped,
      annexureChars,
      annexuresRead: annexuresIncluded.length > 0,
      uploadedAnnexureCount,
    });

    return NextResponse.json({
      success: true,
      runId: String(run._id),
      verdict,
      score,
      summary: isCompliant
        ? "This SOP looks compliant as per AI."
        : `${resolvedCount} of ${results.length} prior point(s) addressed${newIssues.length ? `, ${newIssues.length} new issue(s) found` : ""}.`,
      resolvedCount,
      openCount,
      fileName: file.name,
      fileUrl: uploadedUrl,
      results,
      newIssues,
      sopUpdated,
      annexuresIncluded,
      annexuresSkipped,
      annexureChars,
      annexuresRead: annexuresIncluded.length > 0,
      uploadedAnnexureCount,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Re-check failed",
      },
      { status: 500 },
    );
  }
}
