import {
  baseIdentifierFromIdentifier,
  extractIdentifierFromFilename,
  extractSopCodeFromSegment,
  parseUploadPathMetadata,
  pickBestSopIdentifierFromText,
  preferNewestSopIdentifier,
  sopVersionFields,
  versionFromIdentifier,
} from "@/lib/sop-utils";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { extractRefSopNoFromText } from "@/lib/annexure-parent-extract";

export type SopDocumentKind = "main" | "annexure" | "unknown";

export type SopContentMetadata = {
  documentKind: SopDocumentKind;
  identifier?: string;
  sopBaseId?: string;
  versionNum?: number;
  version?: string;
  annexureLabel?: string;
  parentIdentifier?: string;
  supersedes?: string;
  title?: string;
  /** Exact DEPARTMENT value from the SOP page header, when present. */
  department?: string;
};

const ANNEXURE_NAME = /annex(ure)?|appendix/i;
const SKIP_NAME = /cover\s*page|^index$/i;

const SOP_NO_PATTERN =
  /(?:SOP\s*NO\.?|DOCUMENT\s*NO\.?|DOC\.?\s*NO\.?)\s*:?\s*([A-Z]{2,}[A-Z0-9]*-\d+|[A-Z]{2,}-[A-Z]{2,}-\d+)/i;

const SUPERSEDES_PATTERN =
  /SUPERSEDES\s*:?\s*([A-Z]{2,}[A-Z0-9]*-\d+|[A-Z]{2,}-[A-Z]{2,}-\d+)/i;

const ANNEXURE_LABEL_PATTERN = /(annex(ure)?|appendix)\s*[-–]?\s*([IVXLC\d]+)/i;

export function isAnnexureFileName(fileName: string): boolean {
  return ANNEXURE_NAME.test(fileName) && !SKIP_NAME.test(fileName);
}

export function shouldSkipImportFileName(fileName: string): boolean {
  return (
    fileName.startsWith(".") ||
    fileName.startsWith("~$") ||
    SKIP_NAME.test(fileName.replace(/\.[^.]+$/, ""))
  );
}

function extractSopNoFromContent(content: string): string | undefined {
  const match = content.match(SOP_NO_PATTERN);
  if (!match?.[1]) return undefined;
  return normalizeSopIdentifierKey(match[1]);
}

const DEPARTMENT_HEADER_STOP =
  /\b(?:EFF\.?\s*DATE|REVIEW\s*DT\.?|SUPERSEDES|PAGE\s*NO\.?|SOP\s*NO\.?|DOCUMENT\s*NO\.?|SUBJECT|PREPARED\s*BY|APPROVED\s*BY|વિષય|લાગુ?\s*પડેલ?|ફેર\s*ચકાસણી)\b/i;

/**
 * Read the DEPARTMENT field from the SOP page header (first ~4k of extracted text).
 * Returns the exact header value (trimmed), e.g. "abcd" or "Quality Assurance".
 */
export function extractDepartmentFromContent(content: string): string | undefined {
  if (!content || content.startsWith("[")) return undefined;
  const header = content.slice(0, 4000);
  const match = header.match(/\bDEPARTMENT\b\s*:?\s*/i);
  if (!match || match.index == null) return undefined;

  let raw = header.slice(match.index + match[0].length, match.index + match[0].length + 120);
  const stop = raw.search(DEPARTMENT_HEADER_STOP);
  if (stop >= 0) raw = raw.slice(0, stop);
  // Table extracts often append the next cell with | or multiple spaces
  raw = raw.split("|")[0]?.split(/\t/)[0] ?? raw;
  raw = raw.replace(/\s+/g, " ").trim();
  raw = raw.replace(/^[:.\-–—]+/, "").replace(/[:.\-–—]+$/, "").trim();

  if (!raw || raw.length < 2 || raw.length > 80) return undefined;
  if (/^(nil|n\/?a|none|-|—|--|\.)$/i.test(raw)) return undefined;
  return raw;
}

function extractSupersedesFromContent(content: string): string | undefined {
  const match = content.match(SUPERSEDES_PATTERN);
  if (!match?.[1]) return undefined;
  return normalizeSopIdentifierKey(match[1]);
}

function extractAnnexureLabel(fileName: string): string | undefined {
  const base = fileName.replace(/\.[^.]+$/, "");
  const match = base.match(ANNEXURE_LABEL_PATTERN);
  if (match) {
    const roman = match[3]?.trim();
    const prefix = /annex/i.test(match[1]) ? "Annexure" : "Appendix";
    return roman ? `${prefix}-${roman}` : prefix;
  }
  if (ANNEXURE_NAME.test(base)) return base.split(/\s+/)[0] ?? "Annexure";
  return undefined;
}

function parentFromPath(relativePath: string): string | undefined {
  const pathMeta = parseUploadPathMetadata(relativePath);
  if (pathMeta.identifierFromPath) {
    return normalizeSopIdentifierKey(pathMeta.identifierFromPath);
  }
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  for (let i = segments.length - 2; i >= 0; i--) {
    const code = extractSopCodeFromSegment(segments[i]);
    if (code) return normalizeSopIdentifierKey(code);
  }
  return undefined;
}

function parentIdentifierFromAnnexure(
  fileName: string,
  relativePath: string,
  content?: string,
): string | undefined {
  if (content) {
    const fromRef = extractRefSopNoFromText(content);
    if (fromRef) return fromRef;
    const fromContent = extractSopNoFromContent(content);
    if (fromContent) return fromContent;
  }
  const fromPath = parentFromPath(relativePath);
  if (fromPath) return fromPath;

  const base = fileName.replace(/\.[^.]+$/, "");
  const prefixCode = base.match(/^([A-Z]{2,}[A-Z0-9]*-\d+)\s*[-–_]/i);
  if (prefixCode?.[1]) {
    const best = pickBestSopIdentifierFromText(prefixCode[1]);
    if (best) return normalizeSopIdentifierKey(best);
  }

  const annexPos = base.search(/annex(?:ure)?|appendix/i);
  const searchIn = annexPos > 0 ? base.slice(0, annexPos) : base;
  const best = pickBestSopIdentifierFromText(searchIn);
  if (best) return normalizeSopIdentifierKey(best);
  return undefined;
}

/**
 * Derive document identity from extracted text, filename, and relative path.
 * When filename/path and the document header name the same SOP family at
 * different revisions, the newer revision wins (QAGE20-6.docx + header QAGE20-5
 * → QAGE20-6). Content still wins when the codes are different families.
 */
export function extractSopContentMetadata(opts: {
  content?: string;
  fileName: string;
  relativePath: string;
}): SopContentMetadata {
  const { content = "", fileName, relativePath } = opts;
  const pathMeta = parseUploadPathMetadata(relativePath);
  const rawFromFile = extractIdentifierFromFilename(pathMeta.fileName || fileName);
  const fromFile = rawFromFile ? normalizeSopIdentifierKey(rawFromFile) : undefined;
  const fromContent = content ? extractSopNoFromContent(content) : undefined;
  const fromPathRaw = pathMeta.identifierFromPath
    ? pickBestSopIdentifierFromText(pathMeta.identifierFromPath)
    : undefined;
  const fromPath = fromPathRaw ? normalizeSopIdentifierKey(fromPathRaw) : undefined;

  if (isAnnexureFileName(fileName) || isAnnexureFileName(relativePath)) {
    const parentIdentifier = parentIdentifierFromAnnexure(fileName, relativePath, content);
    return {
      documentKind: "annexure",
      annexureLabel: extractAnnexureLabel(fileName),
      parentIdentifier,
      identifier: parentIdentifier,
      sopBaseId: parentIdentifier ? baseIdentifierFromIdentifier(parentIdentifier) : undefined,
      versionNum: parentIdentifier
        ? sopVersionFields(parentIdentifier).versionNum
        : undefined,
    };
  }

  // Same family, newer revision wins (filename QAGE20-6 beats a stale header QAGE20-5).
  const identifier = preferNewestSopIdentifier(fromContent, fromPath, fromFile);
  const department = content ? extractDepartmentFromContent(content) : undefined;
  if (!identifier) {
    const subjectMatchEmpty = content.match(
      /(?:SUBJECT|વિષય)\s*:?\s*(.+?)\s*(?:EFF\.?\s*DATE|REVIEW\s*DT\.?|SUPERSEDES|PAGE\s*NO\.?|SOP\s*NO\.?|$)/i,
    );
    return {
      documentKind: "main",
      title: subjectMatchEmpty?.[1]?.replace(/\s+/g, " ").trim(),
      department,
    };
  }
  const version =
    pathMeta.versionFromPath ||
    versionFromIdentifier(identifier) ||
    undefined;
  const { sopBaseId, versionNum, version: resolvedVersion } = sopVersionFields(
    identifier,
    version,
    pathMeta.versionFromPath,
  );

  const subjectMatch = content.match(
    /(?:SUBJECT|વિષય)\s*:?\s*(.+?)\s*(?:EFF\.?\s*DATE|REVIEW\s*DT\.?|SUPERSEDES|PAGE\s*NO\.?|SOP\s*NO\.?|$)/i,
  );
  const title = subjectMatch?.[1]?.replace(/\s+/g, " ").trim();

  return {
    documentKind: "main",
    identifier,
    sopBaseId,
    versionNum,
    version: resolvedVersion,
    supersedes: content ? extractSupersedesFromContent(content) : undefined,
    title: title && title.length >= 3 ? title : pathMeta.titleFromPath ?? undefined,
    department,
  };
}
