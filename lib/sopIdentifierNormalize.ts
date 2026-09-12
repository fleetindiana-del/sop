/** Map Unicode / Word dash characters to ASCII hyphen so QAQC01–11 (en-dash) matches QAQC01-11. */
export function normalizeUnicodeHyphens(s: string): string {
  return s.replace(/[‐-―−﹘﹣－]/g, '-');
}

function toAsciiHyphens(s: string): string {
  return normalizeUnicodeHyphens(s);
}

/** BOM / zero-width spaces sometimes appear in copied Excel or DB exports */
function stripInvisible(s: string): string {
  return s.replace(/[​-‍﻿]/g, '');
}

/**
 * Normalize spaces that act as separator between the SOP number and revision
 * (e.g. URL-encoded "MAGE20 28" → "MAGE20-28").
 * Only replaces a single space flanked by alphanumeric characters,
 * so multi-word names are not accidentally collapsed.
 */
function normalizeSpaceAsHyphen(s: string): string {
  // Replace space between digit-sequence and digit-sequence (SOP code separator)
  // e.g. "MAGE20 28" → "MAGE20-28"
  return s.replace(/([A-Za-z]\d+)\s+(\d+)(?=[\s_-]|$)/g, '$1-$2');
}

/**
 * Canonical SOP code for matching registry rows to SOPVersionArtifacts.
 * Collapses: QAQC01-11 vs QAQC1-11, QAQC01-010 vs QAQC01-10, QAQC104-08 vs QAQC104-8.
 * Handles en-dashes and other hyphen variants from filenames / Excel.
 */
export function normalizeSopIdentifierKey(id: string): string {
  let raw = stripInvisible((id || '').trim().toUpperCase());
  raw = normalizeSpaceAsHyphen(raw);
  let u = raw.replace(/\s+/g, '');
  u = toAsciiHyphens(u);
  // Convert underscores to hyphens and collapse multiple hyphens
  u = u.replace(/_/g, '-').replace(/-{2,}/g, '-');

  const m = u.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (m) {
    const letters = m[1].toUpperCase();
    const docNum = parseInt(m[2], 10);
    const rev = parseInt(m[3], 10);
    return `${letters}${docNum}-${rev}`;
  }

  // Fallback: last segment = revision number (handles odd separators if main regex fails)
  const lastHyphen = u.lastIndexOf('-');
  if (lastHyphen <= 0) return u;
  let base = u.slice(0, lastHyphen);
  const suffix = u.slice(lastHyphen + 1);
  const rev = parseInt(suffix, 10);
  if (Number.isNaN(rev)) return u;

  base = toAsciiHyphens(base);
  const bm = base.match(/^([A-Z]{2,6})(\d+)$/);
  if (bm) {
    return `${bm[1].toUpperCase()}${parseInt(bm[2], 10)}-${rev}`;
  }
  return `${base}-${rev}`;
}

/**
 * Stable key for joining SOP registry rows to SOPVersionArtifacts regardless of
 * leading zeros (QAGE01-11 vs QAGE1-11) or hyphen Unicode. Prefer this over
 * string equality for artifact maps.
 */
export function versionArtifactsLookupKey(id: string): string {
  const u = stripInvisible((id || '').trim().toUpperCase().replace(/\s+/g, ''));
  const cleaned = toAsciiHyphens(u);
  const m = cleaned.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (m) {
    return `c:${m[1].toUpperCase()}:${parseInt(m[2], 10)}:${parseInt(m[3], 10)}`;
  }
  return `n:${normalizeSopIdentifierKey(id)}`;
}

/**
 * Document-level SOP code for UI (no revision suffix).
 * Zero-pads the document index: QAGE4-11 → QAGE04, QAGE04-11 → QAGE04.
 * Non-standard identifiers fall back to the base without a trailing `-NN` revision.
 */
export function sopBaseDisplayFromIdentifier(id: string): string {
  const trimmed = String(id || '').trim();
  if (!trimmed) return '';
  const nk = normalizeSopIdentifierKey(trimmed.toUpperCase());
  const m = nk.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (m) {
    return `${m[1]}${String(parseInt(m[2], 10)).padStart(2, '0')}`;
  }
  const docOnly = nk.match(/^([A-Z]{2,6})(\d+)$/);
  if (docOnly) {
    return `${docOnly[1]}${String(parseInt(docOnly[2], 10)).padStart(2, '0')}`;
  }
  return trimmed.toUpperCase().replace(/-\d+$/, '').trim();
}

/**
 * Format an SOP identifier for display with zero-padded section and document numbers.
 * e.g. BSGE1-5 → BSGE01-05, MAGE1-8 → MAGE01-08, MAGE7-4 → MAGE07-04
 * Falls back to the normalized key if the pattern doesn't match.
 */
export function formatSopNoDisplay(id: string): string {
  const nk = normalizeSopIdentifierKey((id || '').trim().toUpperCase());
  const m = nk.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (!m) return nk;
  return `${m[1]}${String(parseInt(m[2], 10)).padStart(2, '0')}-${String(parseInt(m[3], 10)).padStart(2, '0')}`;
}

/**
 * Registry / dashboard SOP number: zero-pad document index, keep revision as integer
 * (QCMI1-0 → QCMI01-0, QAGE4-11 → QAGE04-11).
 */
export function formatSopCodeDisplay(id: string): string {
  const nk = normalizeSopIdentifierKey(String(id || '').trim().toUpperCase());
  const m = nk.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (m) {
    return `${m[1]}${String(parseInt(m[2], 10)).padStart(2, '0')}-${parseInt(m[3], 10)}`;
  }
  const docOnly = nk.match(/^([A-Z]{2,6})(\d+)$/);
  if (docOnly) {
    return `${docOnly[1]}${String(parseInt(docOnly[2], 10)).padStart(2, '0')}`;
  }
  return nk || String(id || '').trim().toUpperCase();
}

/** True when a search string matches a SOP code (raw, display, or padded variants). */
export function sopCodeMatchesSearch(
  query: string,
  sopCode: string,
  displaySopCode?: string,
): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const texts = new Set<string>();
  for (const raw of [sopCode, displaySopCode || '']) {
    if (!raw) continue;
    texts.add(raw.toLowerCase());
    texts.add(formatSopCodeDisplay(raw).toLowerCase());
    texts.add(sopBaseDisplayFromIdentifier(raw).toLowerCase());
    for (const variant of expandSopIdentifierVariants(raw)) {
      texts.add(formatSopCodeDisplay(variant).toLowerCase());
      texts.add(sopBaseDisplayFromIdentifier(variant).toLowerCase());
    }
  }
  for (const t of texts) {
    if (t.includes(q)) return true;
  }
  return false;
}

/**
 * Current approved revision from identifiers like QAGE01-10 → 10 (after normalization).
 * Returns null when there is no numeric `-NN` suffix (e.g. document-only QAGE136).
 */
export function parseRevisionFromSopIdentifier(id: string): number | null {
  const u = normalizeSopIdentifierKey((id || '').trim().toUpperCase());
  const m = u.match(/-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  /** Include 0 (e.g. QAGE133-0 folders / draft rev) */
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Same as {@link parseRevisionFromSopIdentifier} but preserves the original digits
 * (e.g. QAGE01-06 → "06") for display, instead of the leading-zero-stripped number.
 * Mirrors normalizeSopIdentifierKey's separator cleanup but stops short of the
 * parseInt that drops leading zeros.
 */
export function parseRevisionStringFromSopIdentifier(id: string): string | null {
  let raw = stripInvisible((id || '').trim().toUpperCase());
  raw = normalizeSpaceAsHyphen(raw);
  let u = raw.replace(/\s+/g, '');
  u = toAsciiHyphens(u);
  u = u.replace(/_/g, '-').replace(/-{2,}/g, '-');
  const m = u.match(/-(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Logical document family: QAGE01-10 and QAGE01-11 both → QAGE:1 (letters + doc index, no revision).
 * Used to show one registry row per SOP with the highest revision only.
 */
export function sopFamilyKeyFromIdentifier(id: string): string | null {
  const u = normalizeSopIdentifierKey((id || '').trim().toUpperCase());
  const m = u.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (!m) return null;
  return `${m[1].toUpperCase()}:${parseInt(m[2], 10)}`;
}

function stripRevisionSuffix(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

/**
 * True when two SOP codes refer to the same document family (QAGE4 ≡ QAGE04-11).
 */
export function sopFamilyCodesMatch(a: string, b: string): boolean {
  const au = stripRevisionSuffix(a);
  const bu = stripRevisionSuffix(b);
  if (!au || !bu) return false;
  if (au === bu) return true;
  for (const va of expandSopIdentifierVariants(au)) {
    for (const vb of expandSopIdentifierVariants(bu)) {
      if (stripRevisionSuffix(va) === stripRevisionSuffix(vb)) return true;
    }
  }
  const fka =
    sopFamilyKeyFromIdentifier(au) || sopFamilyKeyFromIdentifier(`${au}-0`);
  const fkb =
    sopFamilyKeyFromIdentifier(bu) || sopFamilyKeyFromIdentifier(`${bu}-0`);
  return !!(fka && fkb && fka === fkb);
}

/** Map stripped Excel / matrix codes → canonical DB base keys. */
export function buildExcelToDbBaseLookup(
  registry: Array<{ identifier?: string }>,
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const row of registry) {
    const identifier = String(row?.identifier || '').trim();
    if (!identifier) continue;
    const code = identifier.toUpperCase().replace(/_/g, '-');
    const hyphenated = code.match(/^([A-Z]{2,}[A-Z0-9]*)-\d+$/);
    const segmented = code.match(/^([A-Z]{2,}-[A-Z]{2,})-\d+$/);
    const dbBase = hyphenated?.[1] || segmented?.[1] || stripRevisionSuffix(code);
    if (!dbBase) continue;
    for (const variant of expandSopIdentifierVariants(identifier)) {
      const stripped = stripRevisionSuffix(variant);
      if (stripped) lookup.set(stripped, dbBase);
    }
    const fk = sopFamilyKeyFromIdentifier(identifier);
    if (fk) lookup.set(`@fk:${fk}`, dbBase);
  }
  return lookup;
}

/** Resolve an Excel / matrix code to its DB registry base key, if any. */
export function resolveExcelCodeToDbBase(
  excelCode: string,
  lookup: Map<string, string>,
): string | null {
  const stripped = stripRevisionSuffix(excelCode);
  if (!stripped) return null;
  const direct = lookup.get(stripped);
  if (direct) return direct;
  for (const variant of expandSopIdentifierVariants(excelCode)) {
    const hit = lookup.get(stripRevisionSuffix(variant));
    if (hit) return hit;
  }
  const fk =
    sopFamilyKeyFromIdentifier(stripped) ||
    sopFamilyKeyFromIdentifier(`${stripped}-0`);
  if (fk) {
    const viaFamily = lookup.get(`@fk:${fk}`);
    if (viaFamily) return viaFamily;
  }
  return null;
}

export function dbBasePresentInExcelCodes(
  dbBase: string,
  excelCodes: Set<string>,
  lookup: Map<string, string>,
): boolean {
  if (excelCodes.has(dbBase)) return true;
  for (const c of excelCodes) {
    if (resolveExcelCodeToDbBase(c, lookup) === dbBase) return true;
  }
  return false;
}

/** Common OCR / typing swaps on the letter prefix (MAGF… vs MAGE… in URLs vs DB). */
const LETTER_PREFIX_TYPO_ALIASES: readonly [string, string][] = [
  ['MAGF', 'MAGE'],
  ['MAGE', 'MAGF'],
];

function addLetterPrefixTypoAliases(set: Set<string>) {
  const snapshot = [...set];
  for (const s of snapshot) {
    for (const [a, b] of LETTER_PREFIX_TYPO_ALIASES) {
      if (s.startsWith(a)) {
        const alt = b + s.slice(a.length);
        set.add(alt);
        set.add(normalizeSopIdentifierKey(alt));
      }
    }
  }
}

/**
 * All identifier strings to try when matching Mongo SOP / library / version artifacts
 * (padding, normalization, common prefix typos).
 */
export function expandSopIdentifierVariants(raw: string): string[] {
  const trimmed = stripInvisible((raw || '').trim());
  if (!trimmed) return [];
  // Treat space between letter+digits and digits as hyphen (e.g. "MAGE20 28" → "MAGE20-28")
  const normalized = normalizeSpaceAsHyphen(trimmed.toUpperCase());
  const u = normalized.replace(/\s+/g, '');
  const out = new Set<string>();
  out.add(u);
  const nk = normalizeSopIdentifierKey(u);
  out.add(nk);

  const m = nk.match(/^([A-Z]{2,6})(\d+)-(\d+)$/);
  if (m) {
    const letters = m[1].toUpperCase();
    const doc = parseInt(m[2], 10);
    const rev = parseInt(m[3], 10);
    const docStr = m[2];
    const forms = [
      `${letters}${doc}-${rev}`,
      `${letters}${docStr}-${rev}`,
      `${letters}${String(doc).padStart(2, '0')}-${rev}`,
      `${letters}${String(doc).padStart(3, '0')}-${rev}`,
      `${letters}${doc}-${String(rev).padStart(2, '0')}`,
      `${letters}${doc}-${String(rev).padStart(3, '0')}`,
      /** DB / paths often use zero-padded doc and rev together, e.g. MAGE01-08 vs MAGE1-8 */
      `${letters}${String(doc).padStart(2, '0')}-${String(rev).padStart(2, '0')}`,
      `${letters}${String(doc).padStart(3, '0')}-${String(rev).padStart(2, '0')}`,
      `${letters}${String(doc).padStart(2, '0')}-${String(rev).padStart(3, '0')}`,
      `${letters}${String(doc).padStart(3, '0')}-${String(rev).padStart(3, '0')}`,
    ];
    for (const f of forms) {
      out.add(f);
      out.add(normalizeSopIdentifierKey(f));
    }
  }

  addLetterPrefixTypoAliases(out);
  return [...out].filter(Boolean).slice(0, 64);
}

function escapeMongoRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mongo filter matching any expanded variant of an SOP code (e.g. MAGE12-5 vs MAGE12-05).
 * @param field - `identifier` on SOP / SOPVersionArtifacts; `sopIdentifier` on SOPLibrary.
 */
export function sopIdentifierMatchFilter(
  raw: string,
  field: 'identifier' | 'sopIdentifier' = 'identifier',
): Record<string, unknown> {
  const variants = expandSopIdentifierVariants(raw);
  const uniq = [...new Set(variants.filter(Boolean))];
  if (uniq.length === 0) return { _id: null };
  if (uniq.length === 1) {
    return { [field]: new RegExp(`^${escapeMongoRegex(uniq[0])}$`, 'i') };
  }
  return {
    $or: uniq.map((v) => ({ [field]: new RegExp(`^${escapeMongoRegex(v)}$`, 'i') })),
  };
}
