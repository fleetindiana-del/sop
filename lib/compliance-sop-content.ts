import SOP, { type ISOP } from "@/models/SOP";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";
import {
  isUnusableMcqSourceText,
  normalizeSopTextForMcq,
  scoreSopRecordForMcq,
} from "@/lib/mcq-source-text";
import { isUnextractedDocxContent, reextractDocxContentFromUrl } from "@/lib/prior-header-dates";
import { detectCrossSopReferences } from "@/lib/gmpIntelligence";
import { loadStoredFileBuffer } from "@/lib/loadStoredFileBuffer";
import { fileKindFromStoredPath } from "@/lib/filePathFileKind";
import { extractTextFromBuffer } from "@/lib/extractContent";
import { processGuidelinePDF } from "@/lib/ocrProcessor";
import { isAnnexureFileName } from "@/lib/sop-content-metadata";

/** Marker used when annexure text is merged into compliance / recheck content. */
export const LINKED_ANNEXURES_MARKER =
  "=== LINKED ANNEXURES (forms, logs, and record templates — count as evidence for documentation, data tracking, and record-keeping requirements) ===";

export type AnnexureIncludeInfo = {
  label: string;
  fileName: string;
  chars: number;
};

/**
 * Outcome of the annexure check for a compliance run.
 * - none: no annexure connected to the SOP
 * - checked: connected annexures were included in the guideline audit (done)
 * - not-checked: annexures are connected but this run did not audit them
 * - linked-unread: annexures are connected but text could not be extracted
 */
export type AnnexureAuditStatus = "none" | "checked" | "not-checked" | "linked-unread";

export type ComplianceSopContentResult = {
  record: ISOP;
  content: string;
  source: "primary" | "sibling" | "reextracted";
  referencedSupplementChars: number;
  annexureSupplementChars: number;
  annexuresIncluded: AnnexureIncludeInfo[];
  annexuresSkipped: { label: string; fileName: string; reason: string }[];
  /** How annexures relate to this SOP for the audit. */
  annexureStatus: AnnexureAuditStatus;
  /** Count of sopDocuments marked as annexure (connected), whether readable or not. */
  linkedAnnexureCount: number;
};

export function deriveAnnexureAuditStatus(input: {
  includedCount: number;
  skippedCount: number;
  linkedCount: number;
}): AnnexureAuditStatus {
  if (input.includedCount > 0) return "checked";
  if (input.skippedCount > 0) return "linked-unread";
  if (input.linkedCount > 0) return "not-checked";
  return "none";
}

export function countLinkedAnnexureDocuments(records: ISOP[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const record of records) {
    for (const document of record.sopDocuments ?? []) {
      const path = document.filePath?.trim();
      if (!path) continue;
      const byKind = document.documentKind === "annexure";
      const byName = isAnnexureFileName(document.fileName || path);
      if (!byKind && !byName) continue;
      const key = document.checksum?.trim() || path;
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

const TRUNCATION_MARKER = "\n... [middle of document truncated] ...\n";

/**
 * Keep the head AND the tail of an over-long block. Remediation clauses are usually
 * appended near the end of a revised SOP, so head-only truncation hid exactly the text
 * a re-check needs to see.
 */
function headTailWindow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const tailBudget = Math.floor(budget * 0.4);
  const headBudget = budget - tailBudget;
  return `${text.slice(0, headBudget)}${TRUNCATION_MARKER}${text.slice(text.length - tailBudget)}`;
}

/**
 * Truncate SOP+annexure content for LLM windows without dropping annexure evidence.
 * Reserves ~40% of the budget for the linked-annexures block when present.
 */
export function windowSopContentForAudit(sopContent: string, maxChars: number): string {
  if (sopContent.length <= maxChars) return sopContent;

  const annexIdx = sopContent.indexOf(LINKED_ANNEXURES_MARKER);
  if (annexIdx < 0) {
    return headTailWindow(sopContent, maxChars);
  }

  const main = sopContent.slice(0, annexIdx);
  const rest = sopContent.slice(annexIdx);
  const restBudget = Math.min(
    rest.length,
    Math.max(Math.floor(maxChars * 0.4), Math.min(12_000, Math.floor(maxChars * 0.5))),
  );
  const mainBudget = Math.max(1_000, maxChars - restBudget - 32);
  const mainPart = main.length > mainBudget ? `${headTailWindow(main, mainBudget)}\n` : main;
  const remaining = Math.max(0, maxChars - mainPart.length);
  const restPart =
    rest.length > remaining ? `${rest.slice(0, Math.max(0, remaining - 16))}\n... [truncated]` : rest;
  return mainPart + restPart;
}

function preferEnglish(records: ISOP[]): ISOP[] {
  const english = records.filter((r) => r.language !== "Gujarati");
  return english.length ? english : records;
}

/** Same scoring as MCQ — prefer DOCX with real extracted text over PDF placeholders. */
export function pickBestSopRecordForCompliance(records: ISOP[]): ISOP | null {
  const candidates = preferEnglish(records.filter((r) => !r.isObsolete));
  let best: ISOP | null = null;
  let bestScore = 0;
  for (const r of candidates) {
    const score = scoreSopRecordForMcq(r);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

async function ensureUsableContent(
  record: ISOP,
): Promise<{ content: string; reextracted: boolean }> {
  const score = scoreSopRecordForMcq(record);
  if (!isUnusableMcqSourceText(record.content) && score >= 50) {
    return { content: normalizeSopTextForMcq(record.content), reextracted: false };
  }

  if (
    record.fileType === "docx" &&
    record.fileUrl &&
    (isUnextractedDocxContent(record.content) || isUnusableMcqSourceText(record.content))
  ) {
    const fresh = await reextractDocxContentFromUrl(record.fileUrl);
    if (fresh && !isUnusableMcqSourceText(fresh)) {
      await SOP.updateOne(
        { _id: record._id },
        { $set: { content: fresh, linkedFromBunny: false, updatedAt: new Date() } },
      );
      return { content: normalizeSopTextForMcq(fresh), reextracted: true };
    }
  }

  return { content: normalizeSopTextForMcq(record.content ?? ""), reextracted: false };
}

/**
 * Resolve the best parseable SOP text for compliance (DOCX > PDF, English > Gujarati,
 * re-download DOCX from CDN when DB still has a Bunny placeholder).
 * Linked annexures are included by default so form/log evidence is audited with the SOP.
 */
export async function resolveComplianceSopContent(
  sopId: string,
  opts?: { includeAnnexures?: boolean },
): Promise<ComplianceSopContentResult | null> {
  const includeAnnexures = opts?.includeAnnexures !== false;
  const primary = (await SOP.findById(sopId).lean()) as ISOP | null;
  if (!primary) return null;

  const family = (await SOP.find({
    ...sopIdentifierMatchFilter(primary.identifier),
    isObsolete: { $ne: true },
  }).lean()) as ISOP[];

  const ordered = [
    primary,
    ...family.filter((r) => r._id.toString() !== primary._id.toString()),
  ];
  const best = pickBestSopRecordForCompliance(family.length ? family : [primary]) ?? primary;

  const tryRecords = [
    best,
    ...ordered.filter((r) => r._id.toString() !== best._id.toString()),
  ];

  for (const record of tryRecords) {
    const { content, reextracted } = await ensureUsableContent(record);
    if (content.length >= 50 && scoreSopRecordForMcq({ ...record, content }) >= 50) {
      const source: ComplianceSopContentResult["source"] = reextracted
        ? "reextracted"
        : record._id.toString() === primary._id.toString()
          ? "primary"
          : "sibling";

      const supplement = await buildReferencedSopSupplement(content);
      const familyRecords = family.length ? family : [primary];
      const linkedAnnexureCount = countLinkedAnnexureDocuments(familyRecords);
      const annexureResult = includeAnnexures
        ? await buildAnnexureSupplementDetailed(familyRecords)
        : { text: "", included: [], skipped: [] };
      const annexureSupplement = annexureResult.text;
      const annexureStatus = includeAnnexures
        ? deriveAnnexureAuditStatus({
            includedCount: annexureResult.included.length,
            skippedCount: annexureResult.skipped.length,
            linkedCount: linkedAnnexureCount,
          })
        : "none";
      const parts: string[] = [
        `=== MAIN SOP PROCEDURE ===\n${content.slice(0, 64_000)}`,
      ];
      if (annexureSupplement) {
        parts.push(`${LINKED_ANNEXURES_MARKER}\n${annexureSupplement}`);
      }
      if (supplement) {
        parts.push(`=== REFERENCED / RELATED SOPS ===\n${supplement.slice(0, 8_000)}`);
      }
      const merged =
        parts.length > 1 ? parts.join("\n\n").slice(0, 120_000) : content;

      if (source === "sibling") {
        console.log(
          `[compliance] using sibling ${record.identifier} (${record.fileType}) for audit — primary had weak content`,
        );
      }
      if (reextracted) {
        console.log(`[compliance] re-extracted DOCX text for ${record.identifier}`);
      }
      if (annexureStatus === "checked") {
        console.log(
          `[compliance] ${record.identifier}: annexures checked — ${annexureResult.included.length} file(s) (${annexureSupplement.length} chars)`,
        );
      } else if (annexureStatus === "linked-unread") {
        console.log(
          `[compliance] ${record.identifier}: annexures linked but not readable (${linkedAnnexureCount} connected, ${annexureResult.skipped.length} skipped)`,
        );
      } else {
        console.log(`[compliance] ${record.identifier}: no annexure connected to the SOP`);
      }

      return {
        record: { ...record, content: merged } as ISOP,
        content: merged,
        source,
        referencedSupplementChars: supplement.length,
        annexureSupplementChars: annexureSupplement.length,
        annexuresIncluded: annexureResult.included,
        annexuresSkipped: annexureResult.skipped,
        annexureStatus,
        linkedAnnexureCount,
      };
    }
  }

  return null;
}

export type AnnexureSupplementResult = {
  text: string;
  included: AnnexureIncludeInfo[];
  /** Linked annexure files that could not be extracted (missing file, empty OCR, .doc, etc.). */
  skipped: { label: string; fileName: string; reason: string }[];
};

/**
 * Extract linked annexure files and append them as clearly labelled audit evidence.
 * `opts.exclude` skips files that a caller already has a fresher copy of (e.g. an
 * annexure uploaded with a re-check supersedes the one stored on the SOP record).
 */
export async function buildAnnexureSupplementDetailed(
  records: ISOP[],
  opts?: { exclude?: (info: { label: string; fileName: string }) => boolean },
): Promise<AnnexureSupplementResult> {
  const documents = records.flatMap((record) => record.sopDocuments ?? []);
  const chunks: string[] = [];
  const included: AnnexureIncludeInfo[] = [];
  const skipped: AnnexureSupplementResult["skipped"] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    const path = document.filePath?.trim();
    if (!path) continue;
    const byKind = document.documentKind === "annexure";
    const byName = isAnnexureFileName(document.fileName || path);
    if (!byKind && !byName) continue;
    const dedupeKey = document.checksum?.trim() || path;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const label = document.annexureLabel || document.fileName || "Annexure";
    const fileName = document.fileName || path;
    if (opts?.exclude?.({ label, fileName })) continue;

    try {
      const buffer = await loadStoredFileBuffer(path, { trustedRemote: true });
      if (!buffer) {
        skipped.push({ label, fileName, reason: "file not readable from storage" });
        continue;
      }
      const kind = fileKindFromStoredPath(path, document.fileType);
      if (kind === "doc") {
        skipped.push({ label, fileName, reason: "legacy .doc not supported — use DOCX/PDF" });
        continue;
      }
      const text =
        kind === "pdf"
          ? (await processGuidelinePDF(buffer)).text
          : await extractTextFromBuffer(buffer, "docx");
      if (!text || text.trim().length < 30) {
        skipped.push({ label, fileName, reason: "no extractable text" });
        continue;
      }

      const body = text.trim().slice(0, 12_000);
      chunks.push(`--- ${label} ---\n${body}`);
      included.push({ label, fileName, chars: body.length });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "extract failed";
      skipped.push({ label, fileName, reason });
      console.warn(`[compliance] could not extract annexure ${fileName}:`, reason);
    }
  }

  return {
    text: chunks.join("\n\n").slice(0, 48_000),
    included,
    skipped,
  };
}

/** Extract linked annexure files and append them as clearly labelled audit evidence. */
export async function buildAnnexureSupplement(records: ISOP[]): Promise<string> {
  const { text } = await buildAnnexureSupplementDetailed(records);
  return text;
}

/** Pull text from SOPs this document references (change control, deviation, etc.). */
export async function buildReferencedSopSupplement(primaryContent: string): Promise<string> {
  const refs = detectCrossSopReferences(primaryContent);
  if (!refs.length) return "";

  const chunks: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const pattern = ref.libraryMatch.source;
    if (seen.has(pattern)) continue;
    seen.add(pattern);

    const matches = (await SOP.find({
      isObsolete: { $ne: true },
      $or: [
        { name: { $regex: ref.libraryMatch } },
        { identifier: { $regex: ref.libraryMatch } },
      ],
    })
      .select("identifier name content fileType language fileUrl isObsolete")
      .limit(5)
      .lean()) as ISOP[];

    const best = pickBestSopRecordForCompliance(matches);
    if (!best) continue;

    const { content } = await ensureUsableContent(best);
    if (content.length < 80) continue;

    chunks.push(
      `--- Referenced ${ref.type} (${best.identifier}) ---\n${content.slice(0, 12_000)}`,
    );
  }

  return chunks.join("\n\n").slice(0, 48_000);
}
