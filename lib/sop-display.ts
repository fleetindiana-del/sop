/**
 * Shared SOP No. / SOP Name display helpers.
 *
 * Used by the Main Dashboard's SOP Registry and the MCQ Bank Registry so the
 * SOP number and SOP name render in the EXACT same format in both modules.
 * Keep this as the single source of truth — do not duplicate the logic.
 */

import {
  expandSopIdentifierVariants,
  formatSopCodeDisplay,
  normalizeSopIdentifierKey,
  parseRevisionStringFromSopIdentifier,
  sopBaseDisplayFromIdentifier,
} from "@/lib/sopIdentifierNormalize";

function stripRevisionSuffix(code: string): string {
  return String(code || "").toUpperCase().replace(/-\d+$/, "").trim();
}

/** Prefix variants to strip from titles (raw + zero-padded doc index). */
function titlePrefixCandidates(identifier: string): string[] {
  const out = new Set<string>();
  const formatted = formatSopCodeDisplay(identifier);
  if (formatted) out.add(formatted);
  const raw = String(identifier || "").trim().toUpperCase();
  if (raw) out.add(raw);
  const nk = normalizeSopIdentifierKey(raw);
  if (nk) out.add(nk);
  for (const variant of expandSopIdentifierVariants(identifier)) {
    out.add(formatSopCodeDisplay(variant));
    out.add(stripRevisionSuffix(variant));
    out.add(variant.toUpperCase());
  }
  return [...out].filter(Boolean);
}

/** Canonical SOP code with zero-padded document index (e.g. QCMI1-0 → QCMI01-0). */
export function displaySopCode(identifier: string): string {
  const trimmed = String(identifier || "").trim();
  if (!trimmed) return "";
  return formatSopCodeDisplay(trimmed);
}

/** SOP code without the revision suffix, for the registry's "SOP No" column (QAGE108-3 → QAGE108). */
export function displaySopBaseCode(identifier: string): string {
  const trimmed = String(identifier || "").trim();
  if (!trimmed) return "";
  return sopBaseDisplayFromIdentifier(trimmed) || displaySopCode(trimmed);
}

/** Zero-pad a purely-numeric revision to 2 digits (e.g. "6" → "06", "10" → "10"). Leaves non-integer values (e.g. "1.0") untouched. */
function padRevision(raw: string): string {
  if (!/^\d+$/.test(raw)) return raw;
  return String(parseInt(raw, 10)).padStart(2, "0");
}

/**
 * Revision suffix of an SOP code for the registry's "Version" column (QAGE108-3 → "03").
 * Falls back to the record's stored version when the identifier carries no `-NN` suffix.
 */
export function displaySopRevision(identifier: string, fallbackVersion?: string): string {
  const rev = parseRevisionStringFromSopIdentifier(identifier);
  if (rev !== null) return padRevision(rev);
  const fallback = String(fallbackVersion || "").trim();
  return fallback ? padRevision(fallback) : "—";
}

/** SOP name with the leading SOP code stripped (e.g. "QCMI1-0 - Title" → "Title"). */
export function displaySopTitle(name: string, identifier: string): string {
  if (!name) return name;
  for (const code of titlePrefixCandidates(identifier)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[\\s_-]");
    const stripped = name.replace(new RegExp(`^${escaped}[\\s_-]*`, "i"), "").trim();
    if (stripped && stripped !== name.trim()) return stripped;
  }
  return name;
}
