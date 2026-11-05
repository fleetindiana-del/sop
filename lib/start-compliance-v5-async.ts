import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import type { ISOP } from "@/models/SOP";
import SOPGuideline from "@/models/SOPGuideline";
import { type SopLibraryEntry } from "@/lib/complianceEngineV5";
import { runComplianceReview } from "@/lib/compliance-review-orchestrator";
import { resolveComplianceSopContent } from "@/lib/compliance-sop-content";
import { extractClauses } from "@/lib/ocrProcessor";
import {
  beginComplianceRun,
  endComplianceRun,
  isComplianceAnalysisCancelledError,
  isComplianceRunActiveInProcess,
} from "@/lib/compliance-run-control";
import { checkCodexCliHealth } from "@/lib/llm";
import { getComplianceCodexModel } from "@/lib/codex-cli";
import type { LlmProvider } from "@/lib/llm";

const MAX_CLAUSE_TEXT = 4000;
const GENERIC_NAME = new Set([
  "handling", "general", "operation", "management", "control", "system", "process",
  "product", "quality", "department", "document", "preparation", "issuance", "usage",
  "using", "used", "method", "methods", "standard", "operating", "procedure", "sop",
  "laboratory", "limited", "ophthalmics", "indiana",
]);

type RankedClause = {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  pdfName?: string;
  guidelineId: string;
};

function clauseCap(): number {
  const n = Number(process.env.COMPLIANCE_CLAUSE_CAP ?? 48);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 48;
}

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !GENERIC_NAME.has(token));
}

/** Keep the clauses that match this SOP. Reviewing every stored clause stalls the queue. */
function selectRelevantClauses(sopName: string, sopContent: string, pool: RankedClause[]): RankedClause[] {
  const cap = clauseCap();
  const head = sopContent.slice(0, 4500);
  const fromName = nameTokens(sopName);
  const counts = new Map<string, number>();
  for (const token of nameTokens(head)) {
    if (fromName.includes(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const fromContent = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([token]) => token);

  const ranked = pool
    .filter((clause) => /^\d{1,2}(\.\d{1,3}){0,5}$/.test(clause.clauseNumber.trim()))
    .filter((clause) => clause.clauseText.trim().length >= 80)
    .filter((clause) => !(/\.{4,}/.test(clause.clauseText) && clause.clauseText.length < 280))
    .map((clause) => {
      const title = clause.clauseTitle.toLowerCase();
      const body = `${clause.clauseTitle} ${clause.clauseText.slice(0, 700)}`.toLowerCase();
      let score = 0;
      for (const token of fromName) {
        if (title.includes(token)) score += 6;
        else if (body.includes(token)) score += 2;
      }
      for (const token of fromContent) {
        if (title.includes(token)) score += 2;
        else if (body.includes(token)) score += 1;
      }
      return { clause, score };
    })
    .sort((a, b) => b.score - a.score);

  const strong = ranked.filter((row) => row.score >= 4);
  const chosen = (strong.length >= 8 ? strong : ranked).slice(0, cap);
  const seen = new Set<string>();
  const out: RankedClause[] = [];
  for (const row of chosen) {
    const key = `${row.clause.guidelineId}|${row.clause.clauseNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.clause);
  }
  return out;
}

type StoredClause = { clauseNumber?: string; clauseTitle?: string; clauseText?: string };

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

/**
 * Run a full V5 compliance audit (all OCR-complete guidelines) in the background.
 * Returns immediately after kickoff; errors are logged.
 */
export function triggerComplianceV5Async(opts: {
  sopId: string;
  provider?: LlmProvider;
  model?: string;
  forceRefresh?: boolean;
  includeAnnexures?: boolean;
}): void {
  void runComplianceV5Job(opts).catch((err) => {
    console.error(`[compliance-v5-async] failed for ${opts.sopId}:`, err);
  });
}

export async function runComplianceV5Job(opts: {
  sopId: string;
  provider?: LlmProvider;
  model?: string;
  forceRefresh?: boolean;
  includeAnnexures?: boolean;
}): Promise<void> {
  const sopId = opts.sopId;
  const provider: LlmProvider = opts.provider ?? "codex";
  const model = opts.model ?? (provider === "codex" ? getComplianceCodexModel() : undefined);
  const includeAnnexures = opts.includeAnnexures !== false;

  await connectDB();

  if (provider === "codex") {
    const health = await checkCodexCliHealth();
    if (!health.ok || !health.loggedIn) {
      throw new Error(health.error ?? "Codex CLI is not logged in");
    }
  }

  if (isComplianceRunActiveInProcess(sopId)) {
    console.warn(`[compliance-v5-async] skip ${sopId} — already running`);
    return;
  }

  const sopRow = await SOP.findById(sopId).lean();
  if (!sopRow) throw new Error("SOP not found");

  const resolved = await resolveComplianceSopContent(sopId, { includeAnnexures });
  if (!resolved) {
    throw new Error(
      `SOP "${sopRow.identifier}" has no parseable content. Upload a DOCX version or re-link from storage.`,
    );
  }

  const body = resolved.content.trim();
  if (body.startsWith("%PDF") || body.includes("/Subtype /Image") || body.length < 80) {
    throw new Error(
      `SOP "${sopRow.identifier}" has no readable text (${body.length} chars). Upload a DOCX version.`,
    );
  }

  const sop = { ...resolved.record, content: resolved.content } as unknown as ISOP;

  const guidelines = await SOPGuideline.find({ ocrStatus: "completed" })
    .select("name folderName pdfName rawText clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
    .lean();
  if (!guidelines.length) {
    throw new Error("No guidelines found. Upload guideline PDFs first.");
  }

  const allClauses = guidelines.flatMap((g) =>
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
  const guidelineClauses = selectRelevantClauses(sop.name, sop.content, allClauses);
  if (!guidelineClauses.length) {
    throw new Error(
      `SOP "${sop.identifier}" has readable text but no applicable guideline clauses matched.`,
    );
  }
  console.log(
    `[compliance-v5-async] ${sop.identifier}: using ${guidelineClauses.length} relevant clauses of ${allClauses.length}`,
  );

  const libraryRows = await SOP.find({})
    .select("identifier name isObsolete expiryDate")
    .lean();
  const sopLibrary: SopLibraryEntry[] = libraryRows.map((s) => ({
    identifier: s.identifier,
    name: s.name,
    isObsolete: s.isObsolete,
    expiryDate: s.expiryDate ?? null,
  }));

  const { runEpoch } = beginComplianceRun(sopId);
  try {
    console.log(
      `[compliance-v5-async] ${sop.identifier}: ${guidelineClauses.length} clauses / ${guidelines.length} guidelines via ${provider}`,
    );
    const result = await runComplianceReview({
      sop,
      guidelineClauses,
      sopLibrary,
      provider,
      model,
      mode: "initial",
      forceRefresh: opts.forceRefresh !== false,
      runEpoch,
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
          result.overallScore >= 8
            ? "compliant"
            : result.overallScore >= 5
              ? "partial"
              : "non-compliant",
      },
    );
    console.log(
      `[compliance-v5-async] ${sop.identifier}: done score=${result.overallScore} (${result.processingTimeMs}ms)`,
    );
  } catch (error) {
    if (isComplianceAnalysisCancelledError(error)) {
      console.log(`[compliance-v5-async] ${sopId}: cancelled`);
      return;
    }
    throw error;
  } finally {
    endComplianceRun(sopId);
  }
}

import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";

/** Resolve Mongo ids for SOP identifiers (current non-obsolete preferred). */
export async function resolveSopIdsForIdentifiers(
  identifiers: string[],
): Promise<Array<{ identifier: string; sopId: string }>> {
  await connectDB();
  const out: Array<{ identifier: string; sopId: string }> = [];
  for (const raw of identifiers) {
    const identifier = raw.trim();
    if (!identifier) continue;
    const row =
      (await SOP.findOne({ ...sopIdentifierMatchFilter(identifier), isObsolete: { $ne: true } })
        .select("_id identifier")
        .lean()) ??
      (await SOP.findOne(sopIdentifierMatchFilter(identifier)).select("_id identifier").lean());
    if (row?._id) {
      out.push({ identifier: row.identifier, sopId: (row._id as mongoose.Types.ObjectId).toString() });
    }
  }
  return out;
}
